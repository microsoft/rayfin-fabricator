#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function validateArchiveListing(names, details) {
  const entries = names.trimEnd().split(/\r?\n/)
  if (
    !entries.length ||
    entries.some(
      (name) =>
        !name ||
        path.posix.isAbsolute(name) ||
        /^[a-z]:/i.test(name) ||
        name.split(/[/\\]/).includes('..') ||
        name.startsWith('\\')
    )
  ) {
    throw new Error('Unsafe or empty embedded archive listing.')
  }
  if (
    details
      .trimEnd()
      .split(/\r?\n/)
      .some((line) => !/^[-d]/.test(line))
  ) {
    throw new Error('Embedded archives may contain only regular files and directories.')
  }
}

export async function peMachine(file) {
  const handle = await open(file, 'r')
  try {
    const header = Buffer.alloc(64)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead < 2 || header.toString('ascii', 0, 2) !== 'MZ') return null
    const size = (await handle.stat()).size
    const offset = header.readUInt32LE(60)
    if (bytesRead < 64 || offset < 64 || offset > size - 6) {
      throw new Error(`Invalid PE header in ${file}`)
    }
    const pe = Buffer.alloc(6)
    await handle.read(pe, 0, pe.length, offset)
    if (pe.readUInt32LE(0) !== 0x4550) throw new Error(`Invalid PE signature in ${file}`)
    return `0x${pe.readUInt16LE(4).toString(16).padStart(4, '0')}`
  } finally {
    await handle.close()
  }
}

function authenticode(files) {
  const command = `
    $ErrorActionPreference = 'Stop'
    $paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $results = @(foreach ($file in $paths) {
      $signature = Get-AuthenticodeSignature -LiteralPath $file
      @{
        status = $signature.Status.ToString()
        signerSubject = $signature.SignerCertificate.Subject
        signerThumbprint = $signature.SignerCertificate.Thumbprint
        timestampSubject = $signature.TimeStamperCertificate.Subject
      }
    })
    ConvertTo-Json -InputObject $results -Depth 4 -Compress
  `
  return JSON.parse(
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
      input: JSON.stringify(files),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    })
  )
}

export async function inventoryFiles(files, signatures = authenticode) {
  const records = []
  for (const { file, name } of files) {
    const machine = await peMachine(file)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    records.push({ path: name, size: (await stat(file)).size, sha256: hash.digest('hex'), machine })
  }
  const peFiles = files.filter((_, i) => records[i].machine)
  const results = peFiles.length ? signatures(peFiles.map(({ file }) => file)) : []
  if (
    !Array.isArray(results) ||
    results.length !== peFiles.length ||
    results.some((result) => typeof result.status !== 'string')
  ) {
    throw new Error('Incomplete Authenticode inspection results.')
  }
  let i = 0
  for (const record of records) if (record.machine) record.authenticode = results[i++]
  return records
}

async function filesIn(root, prefix) {
  const files = []
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const file = path.join(root, entry.name)
    const name = `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...(await filesIn(file, name)))
    else if (entry.isFile()) files.push({ file, name })
    else throw new Error(`Unexpected non-regular payload: ${name}`)
  }
  return files
}

export async function findCopilotArchives(build) {
  const archives = []
  // Cargo 1.100 changed the internal build layout; locate the generated files, not a package/hash path.
  for (const entry of await readdir(build, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === 'copilot_cli.archive') {
      const names = await readdir(entry.parentPath)
      if (names.includes('copilot_runtime.archive')) archives.push(entry.parentPath)
    }
  }
  if (archives.length !== 1)
    throw new Error(`Expected one release SDK archive pair, found ${archives.length}.`)
  return archives[0]
}

async function inventory(root) {
  const release = path.join(root, 'src-tauri/target/release')
  const archives = await findCopilotArchives(path.join(release, 'build'))
  const app = path.join(release, 'rayfin-fabricator.exe')
  const sidecar = path.join(root, 'src-tauri/binaries/rayfin-local-x86_64-pc-windows-msvc.exe')
  if (!(await peMachine(app)) || !(await peMachine(sidecar)))
    throw new Error('Missing Windows app or sidecar PE image.')
  const files = [{ file: sidecar, name: 'sidecar/rayfin-local.exe' }]
  for (const entry of await readdir(release, { withFileTypes: true })) {
    if (entry.isFile() && (await peMachine(path.join(release, entry.name)))) {
      files.push({ file: path.join(release, entry.name), name: `release-output/${entry.name}` })
    }
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'fabricator-inventory-'))
  try {
    for (const name of ['copilot_cli.archive', 'copilot_runtime.archive']) {
      const archive = path.join(archives, name)
      const tar = (args) =>
        execFileSync('tar', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      validateArchiveListing(tar(['-tf', archive]), tar(['-tvf', archive]))
      const destination = path.join(scratch, name)
      await mkdir(destination)
      tar(['-xf', archive, '-C', destination])
      files.push({ file: archive, name: `embedded/${name}` })
      files.push(...(await filesIn(destination, `embedded/${name}/members`)))
    }
    return {
      schemaVersion: 1,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim(),
      scope:
        'Unbundled Windows build: top-level PE outputs, pinned sidecar, and both embedded SDK archives. Not a complete installer or recursively embedded sidecar inventory.',
      files: await inventoryFiles(files)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'win32')
      throw new Error('Run this inventory on the Windows build agent.')
    if (!process.argv[2]) throw new Error('Provide the inventory JSON output path.')
    const report = await inventory(ROOT)
    await writeFile(process.argv[2], `${JSON.stringify(report, null, 2)}\n`)
    for (const file of report.files.filter((file) => file.machine)) {
      console.log(
        `${file.path}: ${file.machine}, Authenticode=${file.authenticode.status}, SHA256=${file.sha256}`
      )
    }
  } catch (error) {
    console.error(`Windows release inventory failed: ${error.message}`)
    process.exitCode = 1
  }
}
