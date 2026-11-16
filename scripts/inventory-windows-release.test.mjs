import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  findCopilotArchives,
  inventoryFiles,
  peMachine,
  validateArchiveListing
} from './inventory-windows-release.mjs'

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fabricator-inventory-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pe = Buffer.alloc(128)
  pe.write('MZ')
  pe.writeUInt32LE(64, 60)
  pe.writeUInt32LE(0x4550, 64)
  pe.writeUInt16LE(0x8664, 68)
  const binary = path.join(dir, 'runtime.node')
  const resource = path.join(dir, 'resource.json')
  await writeFile(binary, pe)
  await writeFile(resource, '{}')
  return { binary, resource, pe }
}

test('inventories native addons by PE header and preserves signature status and hashes', async (t) => {
  const { binary, resource, pe } = await fixture(t)
  const files = [
    { file: resource, name: 'resource.json' },
    { file: binary, name: 'runtime.node' }
  ]
  const report = await inventoryFiles(files, (paths) => {
    assert.deepEqual(paths, [binary])
    return [{ status: 'NotSigned', signerSubject: null }]
  })
  assert.equal(report[0].machine, null)
  assert.equal(report[0].authenticode, undefined)
  assert.equal(report[1].machine, '0x8664')
  assert.equal(report[1].size, pe.length)
  assert.equal(report[1].sha256, createHash('sha256').update(pe).digest('hex'))
  assert.equal(report[1].authenticode.status, 'NotSigned')
  assert.equal(JSON.stringify(report).includes(binary), false)
  await assert.rejects(
    inventoryFiles(files, () => []),
    /Incomplete Authenticode/
  )
})

test('fails on malformed executable headers instead of omitting them', async (t) => {
  const { binary, pe } = await fixture(t)
  pe.writeUInt32LE(0xffffffff, 60)
  await writeFile(binary, pe)
  await assert.rejects(peMachine(binary), /Invalid PE header/)
  pe.writeUInt32LE(64, 60)
  pe.writeUInt32LE(0, 64)
  await writeFile(binary, pe)
  await assert.rejects(peMachine(binary), /Invalid PE signature/)
})

test('rejects archive traversal, absolute paths and links before extraction', () => {
  validateArchiveListing(
    'package/\npackage/runtime.node\n',
    'drwxr-xr-x package/\n-rw-r--r-- package/runtime.node\n'
  )
  for (const name of [
    '../outside',
    '/absolute',
    'C:/absolute',
    '\\absolute',
    'nested\\..\\outside',
    ''
  ]) {
    assert.throws(() => validateArchiveListing(name, '-rw-r--r-- file'), /Unsafe or empty/)
  }
  for (const type of ['l', 'h', 'b', 'c', 'p']) {
    assert.throws(
      () => validateArchiveListing('file', `${type}rwxr-xr-x file`),
      /only regular files/
    )
  }
})

test('finds the generated pair across Cargo layouts and rejects missing or ambiguous pairs', async (t) => {
  const { binary } = await fixture(t)
  const root = path.dirname(binary)
  await assert.rejects(findCopilotArchives(root), /found 0/)
  for (const layout of [
    'github-copilot-sdk/hash/build-script-execution/out',
    'github-copilot-sdk-hash/out'
  ]) {
    const out = path.join(root, layout)
    await mkdir(out, { recursive: true })
    await writeFile(path.join(out, 'copilot_cli.archive'), '')
    await assert.rejects(findCopilotArchives(root), /found 0/)
    await writeFile(path.join(out, 'copilot_runtime.archive'), '')
    assert.equal(await findCopilotArchives(root), out)
    await rm(path.join(root, layout.split('/')[0]), { recursive: true })
  }
  for (const name of ['first', 'second']) {
    const out = path.join(root, name)
    await mkdir(out)
    await writeFile(path.join(out, 'copilot_cli.archive'), '')
    await writeFile(path.join(out, 'copilot_runtime.archive'), '')
  }
  await assert.rejects(findCopilotArchives(root), /found 2/)
})

test(
  'inspects Authenticode using Windows PowerShell',
  { skip: process.platform !== 'win32' },
  async () => {
    const [record] = await inventoryFiles([{ file: process.execPath, name: 'node.exe' }])
    assert.ok(record.machine)
    assert.ok(record.authenticode.status)
  }
)
