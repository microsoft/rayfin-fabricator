#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyProof } from './bootstrap-updater-key.mjs'
import { sha256, verifyRelease } from './pr-alpha.mjs'

const SCRIPT = fileURLToPath(import.meta.url)

async function releaseMetadata(folder) {
  const { BUILD_SOURCEVERSION: commit, BUILD_BUILDID: buildId, TEST_RELEASE_PR: pr } = process.env
  return verifyRelease(folder, { commit, buildId, pr })
}

function updaterUrl(metadata) {
  return `https://github.com/microsoft/rayfin-fabricator/releases/download/v${metadata.version}/${encodeURIComponent(metadata.installer.installer.path)}`
}

export async function verifyWindowsUpdater(folder) {
  const metadata = await releaseMetadata(folder)
  const file = path.join(folder, metadata.installer.installer.path)
  const publicKey = await readFile(path.join(folder, '_release/updater.pub'), 'utf8')
  const signature = (await readFile(`${file}.sig`, 'utf8')).trim()
  verifyProof(publicKey, signature, await readFile(file))
  const comment = Buffer.from(signature, 'base64').toString('utf8').split(/\r?\n/)[2]
  assert.ok(
    comment.endsWith(`\tversion:${metadata.version}`),
    'Updater signature has wrong version.'
  )
  const manifest = JSON.parse(await readFile(path.join(folder, 'latest.json'), 'utf8'))
  assert.equal(manifest.version, metadata.version)
  assert.deepEqual(manifest.platforms, {
    'windows-x86_64': { signature, url: updaterUrl(metadata) }
  })
  return manifest
}

export async function signWindowsUpdater(folder, run) {
  const metadata = await releaseMetadata(folder)
  const pr = process.env.TEST_RELEASE_PR
  const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY
  const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  assert.ok(privateKey && !privateKey.startsWith('$('), 'Updater private-key secret is missing.')
  assert.ok(password && !password.startsWith('$('), 'Updater password secret is missing.')
  const file = path.join(folder, metadata.installer.installer.path)
  try {
    // Arguments go directly to the native API, not an OS command line.
    await run([
      'signer',
      'sign',
      '--private-key',
      privateKey,
      '--password',
      password,
      '--app-version',
      metadata.version,
      file
    ])
  } catch {
    throw new Error('Tauri updater signing failed; secret diagnostics suppressed.')
  }
  const signature = (await readFile(`${file}.sig`, 'utf8')).trim()
  assert.equal(
    await sha256(file),
    metadata.installer.installer.sha256,
    'Updater signer changed installer bytes.'
  )
  const manifest = {
    version: metadata.version,
    notes: `Windows review build from PR #${pr}, official build ${metadata.buildId}.`,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature,
        url: updaterUrl(metadata)
      }
    }
  }
  await writeFile(path.join(folder, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return verifyWindowsUpdater(folder)
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  try {
    const [folder, tools] = process.argv.slice(2)
    if (folder === '--worker') {
      let input = ''
      for await (const chunk of process.stdin) input += chunk
      const { args, toolsDirectory } = JSON.parse(input)
      const require = createRequire(path.join(path.resolve(toolsDirectory), 'package.json'))
      const { run } = require('@tauri-apps/cli')
      await run(args)
    } else if (folder === 'verify') {
      await verifyWindowsUpdater(tools)
    } else {
      await signWindowsUpdater(folder, async (args) => {
        execFileSync(process.execPath, [SCRIPT, '--worker'], {
          input: JSON.stringify({ args, toolsDirectory: tools }),
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 120_000
        })
      })
    }
    console.log('Final installer updater signature, signed version and public key verified.')
  } catch (error) {
    console.error(`Windows updater signing failed: ${error.message}`)
    process.exitCode = 1
  }
}
