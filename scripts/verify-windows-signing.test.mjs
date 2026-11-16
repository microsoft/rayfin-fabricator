import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { signingPilotFiles, verifySigningPilot } from './verify-windows-signing.mjs'

test('allows ESRP summary metadata but inventories only the two signed binaries', async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'fabricator-signing-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const names = ['rayfin-fabricator.exe', 'rayfin-local.exe']
  await Promise.all(
    [...names, 'CodeSignSummary-af84d007-e137-4302-b6ef-8fea4a0568ec.md'].map((name) =>
      writeFile(path.join(folder, name), '')
    )
  )
  assert.deepEqual((await signingPilotFiles(folder)).map(({ name }) => name).sort(), names)
  const extra = path.join(folder, 'unexpected.exe')
  await writeFile(extra, '')
  await assert.rejects(signingPilotFiles(folder), /Unexpected staged file/)
  await rm(extra)
  await mkdir(extra)
  await assert.rejects(signingPilotFiles(folder), /Non-regular staged file/)
  await rm(extra, { recursive: true })
  await rm(path.join(folder, names[0]))
  await assert.rejects(signingPilotFiles(folder), /Missing staged pilot binaries/)
})

function fixture() {
  const original = (path) => ({
    path,
    machine: '0x8664',
    sha256: 'before',
    authenticode: { status: 'NotSigned' }
  })
  const before = {
    sourceCommit: 'exact-source',
    files: [original('release-output/rayfin-fabricator.exe'), original('sidecar/rayfin-local.exe')]
  }
  const signed = ['rayfin-fabricator.exe', 'rayfin-local.exe'].map((path) => ({
    path,
    machine: '0x8664',
    sha256: 'after',
    authenticode: {
      status: 'Valid',
      signerSubject: 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US',
      timestampSubject: 'CN=Microsoft Time-Stamp Service'
    }
  }))
  return { before, after: structuredClone(before), signed }
}

test('accepts only timestamped Microsoft pilot signatures with unchanged original payloads', () => {
  const { before, after, signed } = fixture()
  const report = verifySigningPilot(before, after, signed)
  assert.equal(report.sourceCommit, before.sourceCommit)
  assert.equal(report.originalPayloadsUnchanged, true)
  assert.deepEqual(
    report.files.map((file) => file.keyCode),
    ['CP-230012', 'CP-231522']
  )
})

test('rejects altered originals and missing, unchanged, untrusted or untimestamped signatures', () => {
  for (const mutate of [
    ({ after }) => {
      after.files[0].sha256 = 'changed'
    },
    ({ signed }) => {
      signed.pop()
    },
    ({ signed }) => {
      signed[0].sha256 = 'before'
    },
    ({ signed }) => {
      signed[0].machine = '0xaa64'
    },
    ({ signed }) => {
      signed[0].authenticode.status = 'HashMismatch'
    },
    ({ signed }) => {
      signed[0].authenticode.signerSubject = 'CN=Microsoft Corporation, O=Untrusted'
    },
    ({ signed }) => {
      signed[0].authenticode.timestampSubject = null
    },
    ({ before, after }) => {
      before.files[0].authenticode.status = after.files[0].authenticode.status = 'Valid'
    }
  ]) {
    const data = fixture()
    mutate(data)
    assert.throws(() => verifySigningPilot(data.before, data.after, data.signed))
  }
})
