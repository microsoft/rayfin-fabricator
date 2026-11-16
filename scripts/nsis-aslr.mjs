#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function verifyNsisRelocations(image) {
  assert.equal(image.toString('ascii', 0, 2), 'MZ', 'Missing DOS header.')
  const pe = image.readUInt32LE(60)
  assert.equal(image.readUInt32LE(pe), 0x4550, 'Missing PE header.')
  assert.equal(image.readUInt16LE(pe + 4), 0x14c, 'NSIS launcher must remain x86.')
  assert.equal(image.readUInt16LE(pe + 22) & 1, 0, 'PE relocations were stripped.')
  const optional = pe + 24
  assert.equal(image.readUInt16LE(optional), 0x10b, 'Expected PE32 launcher.')
  assert.ok(image.readUInt16LE(optional + 70) & 0x40, 'ASLR is not enabled.')
  assert.ok(image.readUInt16LE(optional + 70) & 0x100, 'DEP is not enabled.')
  assert.ok(image.readUInt32LE(optional + 92) > 5, 'Missing relocation data directory.')
  const rva = image.readUInt32LE(optional + 96 + 5 * 8)
  const size = image.readUInt32LE(optional + 96 + 5 * 8 + 4)
  assert.ok(rva && size >= 12, 'Missing relocation table.')
  const sections = []
  const sectionStart = optional + image.readUInt16LE(pe + 20)
  for (let i = 0; i < image.readUInt16LE(pe + 6); i++) {
    const offset = sectionStart + i * 40
    sections.push({
      name: image.toString('ascii', offset, offset + 8).replace(/\0.*$/, ''),
      rva: image.readUInt32LE(offset + 12),
      size: image.readUInt32LE(offset + 16),
      raw: image.readUInt32LE(offset + 20)
    })
  }
  const relocation = sections.find((section) => section.name === '.reloc')
  assert.ok(relocation, 'No relocation section.')
  assert.equal(relocation.rva, rva, 'Stale relocation-directory RVA.')
  assert.ok(
    size <= relocation.size && relocation.raw + size <= image.length,
    'Truncated relocations.'
  )
  for (const name of ['.ndata', '.rsrc']) {
    const section = sections.find((section) => section.name === name)
    assert.ok(section && relocation.rva < section.rva, `Relocations must precede ${name}.`)
  }
  let cursor = relocation.raw
  const end = cursor + size
  let fixups = 0
  while (cursor < end) {
    assert.ok(cursor + 8 <= end, 'Truncated relocation block header.')
    const page = image.readUInt32LE(cursor)
    const length = image.readUInt32LE(cursor + 4)
    assert.equal(page % 4096, 0, 'Unaligned relocation block.')
    assert.ok(
      length >= 8 && length % 4 === 0 && cursor + length <= end,
      'Invalid relocation block.'
    )
    for (let entry = cursor + 8; entry < cursor + length; entry += 2) {
      const value = image.readUInt16LE(entry)
      const type = value >>> 12
      if (type === 0) continue
      assert.equal(type, 3, 'Expected x86 HIGHLOW relocation.')
      const target = page + (value & 0xfff)
      const section = sections.find(
        (candidate) => target >= candidate.rva && target + 4 <= candidate.rva + candidate.size
      )
      assert.ok(
        section && section.rva < relocation.rva,
        'Relocation targets mutable or unmapped data.'
      )
      assert.ok(
        section.raw + target - section.rva + 4 <= image.length,
        'Truncated relocation target.'
      )
      fixups++
    }
    cursor += length
  }
  assert.ok(fixups > 0, 'Relocation table contains only padding.')
  return {
    imageBase: image.readUInt32LE(optional + 28),
    relocationRva: rva,
    relocationSize: size,
    fixups
  }
}

export function patchNsisSources(gnu, linker) {
  const disable = "conf.CheckLinkFlag('-Wl,--disable-reloc-section')"
  const clone = 'stub_uenv = stub_env.Clone()'
  assert.equal(gnu.split(disable).length, 2, 'Pinned NSIS GNU configuration changed.')
  assert.equal(gnu.split(clone).length, 2, 'Pinned NSIS Unicode configuration changed.')
  gnu = gnu.replace(/^.*conf\.CheckLinkFlag\('-Wl,--disable-reloc-section'\).*[\r\n]*/m, '')
  gnu = gnu.replace(
    clone,
    `stub_env.Append(LINKFLAGS = ['-Wl,--enable-reloc-section', '-Wl,--dynamicbase', '-Wl,--no-insert-timestamp'])\n\n${clone}`
  )
  const relocation =
    / {2}\.reloc BLOCK\(__section_alignment__\) :\r?\n {2}\{\r?\n {4}\*\(\.reloc\)\r?\n {2}\}\r?\n/
  const match = linker.match(relocation)
  assert.ok(match, 'Pinned NSIS relocation linker section changed.')
  linker = linker.replace(relocation, '')
  assert.equal(linker.split('  .ndata BLOCK').length, 2, 'Pinned NSIS data section changed.')
  linker = linker.replace('  .ndata BLOCK', `${match[0]}  .ndata BLOCK`)
  return { gnu, linker }
}

export async function nsisToolFiles(root, prefix = '') {
  const files = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix + entry.name
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) Object.assign(files, await nsisToolFiles(file, `${name}/`))
    else {
      assert.ok(entry.isFile(), `Non-regular NSIS tool: ${name}`)
      files[name] = createHash('sha256')
        .update(await readFile(file))
        .digest('hex')
    }
  }
  return files
}

export async function verifyNsisTools(root, evidence) {
  const report = JSON.parse(await readFile(evidence, 'utf8'))
  assert.equal(report.reproducible, true, 'NSIS stubs were not independently rebuilt.')
  assert.deepEqual(
    await nsisToolFiles(root),
    report.toolFiles,
    'NSIS toolset changed after verification.'
  )
  for (const name of ['lzma-x86-unicode', 'lzma_solid-x86-unicode']) {
    verifyNsisRelocations(await readFile(path.join(root, 'Stubs', name)))
    assert.equal(report.toolFiles[`Stubs/${name}`], report.stubs[name])
  }
  return report
}

export async function recordNsisTools(root, evidence, original) {
  const report = JSON.parse(await readFile(evidence, 'utf8'))
  const expected = await nsisToolFiles(original)
  assert.deepEqual(Object.keys(report.stubs).sort(), ['lzma-x86-unicode', 'lzma_solid-x86-unicode'])
  for (const [name, hash] of Object.entries(report.stubs)) {
    assert.ok(Object.hasOwn(expected, `Stubs/${name}`), 'Missing original NSIS stub.')
    expected[`Stubs/${name}`] = hash
  }
  expected['Plugins/x86-unicode/additional/nsis_tauri_utils.dll'] = report.inputs.plugin.sha256
  report.toolFiles = await nsisToolFiles(root)
  assert.deepEqual(report.toolFiles, expected, 'Unexpected NSIS toolset changes.')
  await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`)
  return verifyNsisTools(root, evidence)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, root, evidence, original] = process.argv.slice(2)
    if (command === 'patch') {
      const gnuFile = path.join(root, 'SCons/Config/gnu')
      const linkerFile = path.join(root, 'SCons/Config/linker_script')
      const result = patchNsisSources(
        await readFile(gnuFile, 'utf8'),
        await readFile(linkerFile, 'utf8')
      )
      await writeFile(gnuFile, result.gnu)
      await writeFile(linkerFile, result.linker)
    } else if (command === 'record') {
      await recordNsisTools(root, evidence, original)
    } else if (command === 'verify') {
      await verifyNsisTools(root, evidence)
    } else throw new Error('Expected patch, record or verify.')
  } catch (error) {
    console.error(`NSIS ASLR verification failed: ${error.message}`)
    process.exitCode = 1
  }
}
