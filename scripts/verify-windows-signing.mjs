#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inventoryFiles, inventoryWindows } from './inventory-windows-release.mjs'

const INPUTS = {
  'rayfin-fabricator.exe': { path: 'release-output/rayfin-fabricator.exe', keyCode: 'CP-230012' },
  'rayfin-local.exe': { path: 'sidecar/rayfin-local.exe', keyCode: 'CP-231522' }
}

export function verifySigningPilot(before, after, signed) {
  assert.deepEqual(after, before, 'Original build payloads or signatures changed during signing.')
  assert.equal(signed.length, 2, 'Expected exactly two signed pilot binaries.')
  for (const [name, input] of Object.entries(INPUTS)) {
    const original = before.files.find((file) => file.path === input.path)
    const result = signed.find((file) => file.path === name)
    assert.ok(original && result, `Missing signing input or result for ${name}.`)
    assert.equal(original.authenticode?.status, 'NotSigned', `Unexpected signed input: ${name}.`)
    assert.equal(result.machine, original.machine, `Changed PE architecture: ${name}.`)
    assert.notEqual(result.sha256, original.sha256, `Signing did not change ${name}.`)
    assert.equal(result.authenticode?.status, 'Valid', `Invalid Authenticode signature: ${name}.`)
    assert.match(
      result.authenticode.signerSubject ?? '',
      /(?:^|,\s*)O=Microsoft Corporation(?:,|$)/,
      `Unexpected signing publisher: ${name}.`
    )
    assert.ok(result.authenticode.timestampSubject, `Missing timestamp: ${name}.`)
  }
  return {
    schemaVersion: 1,
    sourceCommit: before.sourceCommit,
    originalPayloadsUnchanged: true,
    scope: 'Signed pilot copies only; no installer, updater assets, or public distribution.',
    files: signed.map((file) => ({ ...file, keyCode: INPUTS[file.path].keyCode }))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'win32') throw new Error('Signing verification requires Windows.')
    const [folder, baseline, output] = process.argv.slice(2)
    if (!folder || !baseline || !output) {
      throw new Error('Provide the signing directory, baseline inventory, and output report.')
    }
    assert.deepEqual(
      (await readdir(folder)).sort(),
      Object.keys(INPUTS).sort(),
      'Unexpected staged files.'
    )
    const before = JSON.parse(await readFile(baseline, 'utf8'))
    const after = await inventoryWindows()
    const signed = await inventoryFiles(
      Object.keys(INPUTS).map((name) => ({
        name,
        file: path.join(folder, name)
      }))
    )
    const report = verifySigningPilot(before, after, signed)
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(
      'Both pilot binaries have valid timestamped Microsoft signatures; original payloads are unchanged.'
    )
  } catch (error) {
    console.error(`Windows signing verification failed: ${error.message}`)
    process.exitCode = 1
  }
}
