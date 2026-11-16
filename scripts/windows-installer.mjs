#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inventoryFiles } from './inventory-windows-release.mjs'
import { sha256 } from './pr-alpha.mjs'

const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SCRIPT), '..')
const pause = () => new Promise((resolve) => setTimeout(resolve, 1000))
const read = async (file) => JSON.parse(await readFile(file, 'utf8'))
async function optionalRead(file) {
  try {
    return await read(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
async function atomicJson(file, data) {
  await writeFile(`${file}.tmp`, JSON.stringify(data))
  await rename(`${file}.tmp`, file)
}

export function installerKeyCode(file, root, temporary) {
  const resolved = path.resolve(file)
  const release = path
    .relative(path.resolve(root, 'src-tauri/target/release'), resolved)
    .replaceAll('\\', '/')
  if (/^bundle\/nsis\/Rayfin Fabricator_\d+\.\d+\.\d+(?:-[\w.-]+)?_x64-setup\.exe$/.test(release)) {
    return 'CP-230012'
  }
  // NSIS !uninstfinalize supplies a PE named nst<hex>.tmp, not uninstall.exe.
  if (
    path.dirname(resolved) === path.resolve(temporary) &&
    /^nst[\da-f]{1,4}\.tmp$/i.test(path.basename(file))
  ) {
    return 'CP-230012'
  }
  const plugin = release.replace(/^nsis\/x64\/Plugins\/x86-unicode\//, '')
  assert.ok(
    plugin !== release &&
      [
        'NSISdl.dll',
        'StartMenu.dll',
        'System.dll',
        'nsDialogs.dll',
        'additional/nsis_tauri_utils.dll'
      ].includes(plugin),
    `Unknown installer signing input: ${path.basename(file)}`
  )
  return 'CP-231522'
}

export function requireMicrosoftSignature(file, keyCode) {
  assert.equal(file.authenticode?.status, 'Valid', `Invalid signature: ${file.path}`)
  assert.ok(file.authenticode.timestampSubject, `Missing timestamp: ${file.path}`)
  assert.match(file.authenticode.signerSubject, /(?:^|,\s*)O=Microsoft Corporation(?:,|$)/)
  if (keyCode === 'CP-230012') {
    assert.match(file.authenticode.signerSubject, /(?:^|,\s*)CN=Microsoft Corporation(?:,|$)/)
  } else if (keyCode === 'CP-231522') {
    assert.match(
      file.authenticode.signerSubject,
      /(?:^|,\s*)CN=Microsoft 3rd Party Application Component(?:,|$)/
    )
  }
}

export async function awaitInstallerRequest(state, timeout = 600_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const request = await optionalRead(path.join(state, 'request.json'))
    if (request && !(await optionalRead(path.join(state, `${request.id}.approved.json`)))) {
      return request
    }
    const done = await optionalRead(path.join(state, 'done.json'))
    if (done) {
      assert.equal(
        done.success,
        true,
        'Tauri bundling failed; inspect installer.stdout/stderr logs.'
      )
      return null
    }
    await pause()
  }
  throw new Error('Timed out waiting for Tauri signing callback or completion.')
}

async function signingCallback(state, file) {
  const config = await read(path.join(state, 'config.json'))
  const existing = config.signedInputs.find(
    (input) => path.resolve(input.file).toLowerCase() === path.resolve(file).toLowerCase()
  )
  const [before] = await inventoryFiles([{ name: path.basename(file), file }])
  if (existing) {
    assert.equal(before.sha256, existing.sha256, 'Packaging changed an already-signed input.')
    requireMicrosoftSignature(before)
    return
  }
  const keyCode = installerKeyCode(file, ROOT, config.temporary)
  assert.equal(
    before.authenticode?.status,
    'NotSigned',
    'Refusing to overwrite a received signature.'
  )
  const id = randomUUID()
  const folder = path.join(state, id)
  await mkdir(folder)
  const name = path.extname(file).toLowerCase() === '.tmp' ? 'uninstall.exe' : path.basename(file)
  const staged = path.join(folder, name)
  await copyFile(file, staged)
  assert.equal(await sha256(staged), before.sha256, 'Staging changed installer callback bytes.')
  await atomicJson(path.join(state, 'request.json'), {
    id,
    file: path.resolve(file),
    staged,
    folder,
    name,
    keyCode,
    before
  })
  const deadline = Date.now() + 30 * 60_000
  while (Date.now() < deadline) {
    const approved = await optionalRead(path.join(state, `${id}.approved.json`))
    if (approved) {
      assert.equal(
        await sha256(file),
        before.sha256,
        'Installer input changed while awaiting ESRP.'
      )
      assert.equal(await sha256(staged), approved.sha256, 'Approved ESRP result changed.')
      await copyFile(staged, file)
      return
    }
    await pause()
  }
  throw new Error('Timed out waiting for ESRP signing approval.')
}

async function bundle(state) {
  try {
    const { run } = await import('@tauri-apps/cli')
    await run([
      'bundle',
      '--ci',
      '--bundles',
      'nsis',
      '--no-binary-patching',
      '--config',
      path.join(state, 'tauri.installer.json')
    ])
    await atomicJson(path.join(state, 'done.json'), { success: true })
  } catch (error) {
    await atomicJson(path.join(state, 'done.json'), { success: false })
    throw error
  }
}

async function prepare(state, validation, signing) {
  await mkdir(state)
  const report = await read(path.join(validation, 'windows-signing-pilot.json'))
  const signedInputs = []
  for (const [name, destinations] of [
    ['rayfin-fabricator.exe', ['src-tauri/target/release/rayfin-fabricator.exe']],
    [
      'rayfin-local.exe',
      [
        'src-tauri/target/release/rayfin-local.exe',
        'src-tauri/binaries/rayfin-local-x86_64-pc-windows-msvc.exe'
      ]
    ]
  ]) {
    const expected = report.files.find((file) => file.path === name)
    assert.ok(expected, `Missing verified pilot result: ${name}`)
    requireMicrosoftSignature(expected)
    const source = path.join(signing, name)
    assert.equal(await sha256(source), expected.sha256, 'Verified signing input changed.')
    for (const destination of destinations) {
      const file = path.join(ROOT, destination)
      await copyFile(source, file)
      signedInputs.push({ file, sha256: expected.sha256 })
    }
  }
  await atomicJson(path.join(state, 'config.json'), {
    signedInputs,
    temporary: path.join(state, 'temp')
  })
  await mkdir(path.join(state, 'temp'))
  await atomicJson(path.join(state, 'tauri.installer.json'), {
    bundle: {
      createUpdaterArtifacts: false,
      windows: {
        allowDowngrades: false,
        signCommand: { cmd: process.execPath, args: [SCRIPT, 'sign', state, '%1'] }
      }
    }
  })
}

async function approve(state) {
  const request = await read(path.join(state, 'request.json'))
  const config = await read(path.join(state, 'config.json'))
  assert.equal(request.keyCode, installerKeyCode(request.file, ROOT, config.temporary))
  const [signed] = await inventoryFiles([{ name: request.name, file: request.staged }])
  requireMicrosoftSignature(signed, request.keyCode)
  assert.equal(signed.machine, request.before.machine)
  assert.notEqual(signed.sha256, request.before.sha256)
  await atomicJson(path.join(state, `${request.id}.approved.json`), {
    ...signed,
    keyCode: request.keyCode
  })
}

async function finish(state, validation) {
  assert.equal((await read(path.join(state, 'done.json'))).success, true)
  const { signedInputs } = await read(path.join(state, 'config.json'))
  for (const input of signedInputs) {
    assert.equal(
      await sha256(input.file),
      input.sha256,
      'Packaging invalidated a product signature.'
    )
  }
  const folder = path.join(ROOT, 'src-tauri/target/release/bundle/nsis')
  const names = (await readdir(folder)).filter((name) => name.endsWith('-setup.exe'))
  assert.equal(names.length, 1, 'Expected exactly one NSIS installer.')
  const [installer] = await inventoryFiles([{ name: names[0], file: path.join(folder, names[0]) }])
  requireMicrosoftSignature(installer)
  const helpers = []
  for (const name of await readdir(state)) {
    if (name.endsWith('.approved.json')) helpers.push(await read(path.join(state, name)))
  }
  assert.ok(
    helpers.some((file) => file.path.endsWith('.dll')),
    'NSIS DLL signing was not exercised.'
  )
  assert.ok(
    helpers.filter((file) => file.path.endsWith('.exe')).length >= 2,
    'Installer and uninstaller signing were not both exercised.'
  )
  await writeFile(
    path.join(validation, 'windows-installer.json'),
    JSON.stringify({ installer, helpers, signedInputsUnchanged: true }, null, 2)
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  try {
    const [command, state, first, second] = process.argv.slice(2)
    if (command === 'prepare') await prepare(state, first, second)
    else if (command === 'bundle') await bundle(state)
    else if (command === 'sign') await signingCallback(state, first)
    else if (command === 'wait') {
      const request = await awaitInstallerRequest(state)
      console.log(`##vso[task.setvariable variable=InstallerSigningPending]${!!request}`)
      if (request) {
        console.log(`##vso[task.setvariable variable=InstallerSigningFolder]${request.folder}`)
        console.log(`##vso[task.setvariable variable=InstallerSigningPattern]${request.name}`)
        console.log(`##vso[task.setvariable variable=InstallerSigningKeyCode]${request.keyCode}`)
      }
    } else if (command === 'approve') await approve(state)
    else if (command === 'finish') await finish(state, first)
    else throw new Error('Expected prepare, bundle, sign, wait, approve or finish.')
  } catch (error) {
    console.error(`Windows installer signing failed: ${error.message}`)
    process.exitCode = 1
  }
}
