import assert from 'node:assert/strict'
import test from 'node:test'
import { verifySigningPilot } from './verify-windows-signing.mjs'

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
