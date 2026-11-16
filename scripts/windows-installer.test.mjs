import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  awaitInstallerRequest,
  installerKeyCode,
  requireMicrosoftSignature
} from './windows-installer.mjs'

test('classifies only installer build paths and known component helpers', () => {
  const root = path.resolve('fixture')
  const temp = path.resolve('agent-temp')
  assert.equal(
    installerKeyCode(
      path.join(
        root,
        'src-tauri/target/release/bundle/nsis/Rayfin Fabricator_1.55.0-alpha.123_x64-setup.exe'
      ),
      root,
      temp
    ),
    'CP-230012'
  )
  assert.equal(installerKeyCode(path.join(temp, 'nst1234.tmp'), root, temp), 'CP-230012')
  assert.equal(
    installerKeyCode(
      path.join(root, 'src-tauri/target/release/nsis/x64/Plugins/x86-unicode/System.dll'),
      root,
      temp
    ),
    'CP-231522'
  )
  for (const file of [
    path.join(root, 'src-tauri/tauri.conf.json'),
    path.join(temp, '../escape.exe'),
    path.join(temp, 'unknown.dll')
  ]) {
    assert.throws(() => installerKeyCode(file, root, temp))
  }
})

test('requires a valid timestamped Microsoft publisher for every approved result', () => {
  const file = {
    path: 'installer.exe',
    authenticode: {
      status: 'Valid',
      timestampSubject: 'Microsoft Time-Stamp Service',
      signerSubject: 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US'
    }
  }
  requireMicrosoftSignature(file)
  for (const change of [
    { status: 'NotSigned' },
    { timestampSubject: null },
    { signerSubject: 'CN=Microsoft Corporation, O=Other' }
  ]) {
    assert.throws(() =>
      requireMicrosoftSignature({ ...file, authenticode: { ...file.authenticode, ...change } })
    )
  }
})

test('waits for new callbacks rather than signing the previous approved request twice', async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'fabricator-installer-test-'))
  t.after(() => rm(state, { recursive: true, force: true }))
  const request = { id: 'request-one' }
  await writeFile(path.join(state, 'request.json'), JSON.stringify(request))
  assert.deepEqual(await awaitInstallerRequest(state), request)
  await writeFile(path.join(state, `${request.id}.approved.json`), '{}')
  await writeFile(path.join(state, 'done.json'), '{"success":true}')
  assert.equal(await awaitInstallerRequest(state), null)
  await writeFile(path.join(state, 'done.json'), '{"success":false}')
  await assert.rejects(awaitInstallerRequest(state), /Tauri bundling failed/)
})
