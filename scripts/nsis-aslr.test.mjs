import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  nsisToolFiles,
  patchNsisSources,
  recordNsisTools,
  verifyNsisRelocations,
  verifyNsisTools
} from './nsis-aslr.mjs'

function launcher() {
  const image = Buffer.alloc(0xa00)
  image.write('MZ')
  image.writeUInt32LE(0x80, 60)
  image.writeUInt32LE(0x4550, 0x80)
  image.writeUInt16LE(0x14c, 0x84)
  image.writeUInt16LE(4, 0x86)
  image.writeUInt16LE(224, 0x94)
  image.writeUInt16LE(0x102, 0x96)
  const optional = 0x98
  image.writeUInt16LE(0x10b, optional)
  image.writeUInt32LE(0x400000, optional + 28)
  image.writeUInt16LE(0x140, optional + 70)
  image.writeUInt32LE(16, optional + 92)
  image.writeUInt32LE(0x2000, optional + 96 + 5 * 8)
  image.writeUInt32LE(12, optional + 96 + 5 * 8 + 4)
  const sections = [
    ['.text', 0x1000, 0x400, 0x200],
    ['.reloc', 0x2000, 0x600, 0x200],
    ['.ndata', 0x3000, 0, 0],
    ['.rsrc', 0x4000, 0x800, 0x200]
  ]
  sections.forEach(([name, rva, raw, size], i) => {
    const offset = optional + 224 + i * 40
    image.write(name, offset)
    image.writeUInt32LE(rva, offset + 12)
    image.writeUInt32LE(size, offset + 16)
    image.writeUInt32LE(raw, offset + 20)
  })
  image.writeUInt32LE(0x1000, 0x600)
  image.writeUInt32LE(12, 0x604)
  image.writeUInt16LE(0x3010, 0x608)
  return image
}

test('requires a usable relocation table before sections mutated by NSIS', () => {
  assert.equal(verifyNsisRelocations(launcher()).fixups, 1)
  for (const corrupt of [
    (image) => image.writeUInt16LE(0x103, 0x96),
    (image) => image.writeUInt16LE(0x100, 0x98 + 70),
    (image) => image.writeUInt32LE(0, 0x98 + 96 + 5 * 8),
    (image) => image.writeUInt32LE(0x3000, 0x98 + 96 + 5 * 8),
    (image) => image.writeUInt32LE(0, 0x604),
    (image) => image.writeUInt32LE(16, 0x604),
    (image) => image.writeUInt32LE(0x3000, 0x600),
    (image) => image.writeUInt16LE(0, 0x608),
    (image) => image.writeUInt16LE(0xa010, 0x608),
    (image) => image.writeUInt32LE(0x1800, 0x98 + 224 + 2 * 40 + 12)
  ]) {
    const image = launcher()
    corrupt(image)
    assert.throws(() => verifyNsisRelocations(image))
  }
})

test('patches only the pinned GNU relocation flags and section ordering, refusing drift', () => {
  const gnu =
    "conf.CheckLinkFlag('-Wl,--disable-reloc-section') # stock\nstub_uenv = stub_env.Clone()\n"
  const linker =
    '  .ndata BLOCK(__section_alignment__) :\n  {\n    *(.ndata)\n  }\n  .reloc BLOCK(__section_alignment__) :\n  {\n    *(.reloc)\n  }\n'
  const patched = patchNsisSources(gnu, linker)
  assert.ok(patched.gnu.includes('--enable-reloc-section'))
  assert.ok(!patched.gnu.includes('--disable-reloc-section'))
  assert.ok(patched.linker.indexOf('.reloc BLOCK') < patched.linker.indexOf('.ndata BLOCK'))
  assert.throws(() => patchNsisSources(patched.gnu, patched.linker))
  assert.throws(() => patchNsisSources(gnu, linker.replace('.ndata BLOCK', '.other BLOCK')))
})

test('binds packaging to the independently rebuilt stubs and unchanged toolset', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fabricator-nsis-tools-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const tools = path.join(root, 'tools')
  const original = path.join(root, 'original')
  await mkdir(path.join(original, 'Stubs'), { recursive: true })
  await mkdir(path.join(tools, 'Stubs'), { recursive: true })
  for (const name of ['lzma-x86-unicode', 'lzma_solid-x86-unicode']) {
    await writeFile(path.join(original, 'Stubs', name), 'stock stub')
    await writeFile(path.join(tools, 'Stubs', name), launcher())
  }
  const toolFiles = await nsisToolFiles(tools)
  const record = {
    reproducible: true,
    stubs: Object.fromEntries(
      Object.entries(toolFiles).map(([name, hash]) => [path.basename(name), hash])
    )
  }
  const pluginName = 'Plugins/x86-unicode/additional/nsis_tauri_utils.dll'
  await mkdir(path.dirname(path.join(tools, pluginName)), { recursive: true })
  await writeFile(path.join(tools, pluginName), 'pinned plugin')
  record.inputs = { plugin: { sha256: (await nsisToolFiles(tools))[pluginName] } }
  const evidence = path.join(root, 'evidence.json')
  await writeFile(evidence, JSON.stringify(record))
  await recordNsisTools(tools, evidence, original)
  await verifyNsisTools(tools, evidence)
  await writeFile(path.join(tools, 'unexpected.dll'), 'unapproved tool change')
  await assert.rejects(
    recordNsisTools(tools, evidence, original),
    /Unexpected NSIS toolset changes/
  )
  await rm(path.join(tools, 'unexpected.dll'))
  await writeFile(path.join(tools, 'Stubs/lzma-x86-unicode'), 'stock nonrelocatable replacement')
  await assert.rejects(verifyNsisTools(tools, evidence), /toolset changed/)
  const fromDisk = JSON.parse(await readFile(evidence, 'utf8'))
  fromDisk.reproducible = false
  await writeFile(evidence, JSON.stringify(fromDisk))
  await assert.rejects(verifyNsisTools(tools, evidence), /independently rebuilt/)
})
