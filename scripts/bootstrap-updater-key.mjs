#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SCRIPT), '..')
export const VAULT = {
  subscription: '47d8d56c-3a05-4e1a-805b-87cc4b1ba5a3',
  resourceGroup: 'team-rg',
  name: 'appdev-team-kv'
}
export const SECRETS = {
  password: 'fabricator-updater-password',
  privateKey: 'fabricator-updater-private-key'
}
const SECRET_NAMES = Object.values(SECRETS)
const PROOF = 'Rayfin Fabricator updater key custody verification\n'

function azure(args, operation) {
  try {
    return execFileSync(
      'az',
      [...args, '--subscription', VAULT.subscription, '--only-show-errors', '--output', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch {
    // Azure errors can include request/response data. Never forward them for secret operations.
    throw new Error(
      `Azure CLI failed during ${operation}. Diagnostics withheld to protect secrets; check Azure login, vault RBAC and network access.`
    )
  }
}

export function ensureUnused(secrets, deleted) {
  for (const name of SECRET_NAMES) {
    assert.ok(
      ![...secrets, ...deleted].some((entry) => entry.name === name),
      `${name} already exists or is soft-deleted. Refusing to replace, recover or rotate it.`
    )
  }
}

export function verifyProof(publicKey, signature, data) {
  const keyLines = Buffer.from(publicKey.trim(), 'base64').toString('utf8').trim().split(/\r?\n/)
  const sigLines = Buffer.from(signature.trim(), 'base64').toString('utf8').trim().split(/\r?\n/)
  assert.equal(keyLines.length, 2, 'Invalid Tauri public key.')
  assert.equal(sigLines.length, 4, 'Invalid Tauri signature.')
  const key = Buffer.from(keyLines[1], 'base64')
  const signed = Buffer.from(sigLines[1], 'base64')
  assert.equal(key.length, 42, 'Invalid minisign public-key packet.')
  assert.equal(key.toString('ascii', 0, 2), 'Ed')
  assert.equal(signed.length, 74, 'Invalid minisign signature packet.')
  assert.ok(key.subarray(2, 10).equals(signed.subarray(2, 10)), 'Signing key ID mismatch.')
  const algorithm = signed.toString('ascii', 0, 2)
  assert.ok(algorithm === 'Ed' || algorithm === 'ED', 'Unsupported minisign algorithm.')
  const verifier = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]),
    format: 'der',
    type: 'spki'
  })
  const payload = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data
  assert.ok(verify(null, payload, verifier, signed.subarray(10)), 'Proof signature did not verify.')
  assert.ok(sigLines[2].startsWith('trusted comment: '), 'Missing signed comment.')
  assert.ok(
    verify(
      null,
      Buffer.concat([
        signed.subarray(10),
        Buffer.from(sigLines[2].slice('trusted comment: '.length))
      ]),
      verifier,
      Buffer.from(sigLines[3], 'base64')
    ),
    'Proof comment signature did not verify.'
  )
}

function tauriWorker(command, privateKeyFile, password, proofFile) {
  try {
    execFileSync(process.execPath, [SCRIPT, '--tauri-worker'], {
      input: JSON.stringify({ command, privateKeyFile, password, proofFile }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true' }
    })
  } catch {
    throw new Error(`Tauri ${command} failed. Diagnostics withheld to protect key material.`)
  }
}

export function vaultStore(runAzure = azure) {
  return {
    preflight() {
      const vault = JSON.parse(
        runAzure(
          [
            'keyvault',
            'show',
            '--resource-group',
            VAULT.resourceGroup,
            '--name',
            VAULT.name,
            '--query',
            '{id:id,uri:properties.vaultUri,rbac:properties.enableRbacAuthorization,softDelete:properties.enableSoftDelete,purgeProtection:properties.enablePurgeProtection}'
          ],
          'vault metadata validation'
        )
      )
      const expected = `/subscriptions/${VAULT.subscription}/resourceGroups/${VAULT.resourceGroup}/providers/Microsoft.KeyVault/vaults/${VAULT.name}`
      assert.equal(vault.id.toLowerCase(), expected.toLowerCase(), 'Unexpected target vault.')
      assert.equal(vault.uri, `https://${VAULT.name}.vault.azure.net/`)
      const list = (command) =>
        JSON.parse(
          runAzure(
            [
              'keyvault',
              'secret',
              command,
              '--vault-name',
              VAULT.name,
              '--query',
              `[?name=='${SECRETS.password}' || name=='${SECRETS.privateKey}'].{name:name}`
            ],
            `${command} secret-name preflight`
          )
        )
      ensureUnused(list('list'), list('list-deleted'))
      return vault
    },
    upload(name, file) {
      const id = JSON.parse(
        runAzure(
          [
            'keyvault',
            'secret',
            'set',
            '--vault-name',
            VAULT.name,
            '--name',
            name,
            '--file',
            file,
            '--encoding',
            'utf-8',
            '--content-type',
            'text/plain',
            '--tags',
            'application=rayfin-fabricator',
            'purpose=tauri-updater',
            '--query',
            'id'
          ],
          `upload of ${name}`
        )
      )
      assert.match(
        id,
        new RegExp(`^https://${VAULT.name}\\.vault\\.azure\\.net/secrets/${name}/[0-9a-f]+$`),
        'Vault did not return the expected versioned secret ID.'
      )
      return id
    },
    download(id, file) {
      runAzure(
        ['keyvault', 'secret', 'download', '--id', id, '--file', file, '--encoding', 'utf-8'],
        'version-pinned secret readback'
      )
    }
  }
}

export async function provisionUpdaterKey({
  publicKeyFile,
  store = vaultStore(),
  generate = (file, password) => tauriWorker('generate', file, password),
  sign = (file, password, proof) => tauriWorker('sign', file, password, proof),
  log = console.log
}) {
  assert.equal(
    process.platform === 'win32',
    false,
    'Run this bootstrap on macOS/Linux for POSIX file protection.'
  )
  assert.ok(
    !existsSync(publicKeyFile),
    'Public-key output already exists; refusing to overwrite it.'
  )
  const metadataFile = `${publicKeyFile}.vault.json`
  assert.ok(!existsSync(metadataFile), 'Custody receipt already exists; refusing to overwrite it.')
  const vault = await store.preflight()
  if (!vault.purgeProtection) {
    log(
      'Warning: vault purge protection is not enabled. Arrange protected recovery/retention with its owner.'
    )
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'fabricator-updater-bootstrap-'))
  const previousMask = process.umask(0o077)
  let complete = false
  try {
    await chmod(scratch, 0o700)
    const passwordFile = path.join(scratch, 'password')
    const privateKeyFile = path.join(scratch, 'updater.key')
    const proofFile = path.join(scratch, 'proof.txt')
    const password = randomBytes(48).toString('base64url')
    await writeFile(passwordFile, password, { mode: 0o600, flag: 'wx' })
    log(`Uploading ${SECRETS.password}; no secret values will be printed.`)
    const passwordId = await store.upload(SECRETS.password, passwordFile)
    const journal = path.join(scratch, 'custody.json')
    await writeFile(journal, JSON.stringify({ passwordSecretId: passwordId }), {
      mode: 0o600,
      flag: 'wx'
    })
    const restoredPassword = path.join(scratch, 'password.readback')
    await store.download(passwordId, restoredPassword)
    assert.ok(
      (await readFile(restoredPassword)).equals(await readFile(passwordFile)),
      'Password vault readback mismatch.'
    )
    log('Generating a password-encrypted Tauri key pair.')
    await generate(privateKeyFile, password)
    await chmod(privateKeyFile, 0o600)
    const publicKey = await readFile(`${privateKeyFile}.pub`, 'utf8')
    await writeFile(proofFile, PROOF, { mode: 0o600, flag: 'wx' })
    await sign(privateKeyFile, password, proofFile)
    verifyProof(publicKey, await readFile(`${proofFile}.sig`, 'utf8'), Buffer.from(PROOF))
    log(`Uploading ${SECRETS.privateKey}.`)
    const privateKeyId = await store.upload(SECRETS.privateKey, privateKeyFile)
    await writeFile(
      journal,
      JSON.stringify({ passwordSecretId: passwordId, privateKeySecretId: privateKeyId })
    )
    const restoredKey = path.join(scratch, 'updater.readback.key')
    await store.download(privateKeyId, restoredKey)
    assert.ok(
      (await readFile(restoredKey)).equals(await readFile(privateKeyFile)),
      'Private-key vault readback mismatch.'
    )
    await rm(`${proofFile}.sig`)
    await sign(restoredKey, await readFile(restoredPassword, 'utf8'), proofFile)
    verifyProof(publicKey, await readFile(`${proofFile}.sig`, 'utf8'), Buffer.from(PROOF))
    await mkdir(path.dirname(publicKeyFile), { recursive: true })
    await writeFile(publicKeyFile, `${publicKey.trim()}\n`, { flag: 'wx', mode: 0o644 })
    const receipt = {
      vault: vault.uri,
      passwordSecretId: passwordId,
      privateKeySecretId: privateKeyId,
      publicKeySha256: createHash('sha256').update(publicKey.trim()).digest('hex'),
      verifiedRoundTrip: true
    }
    await writeFile(metadataFile, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o644
    })
    complete = true
    log(`Verified vault round trip and signing proof. Public key: ${publicKeyFile}`)
    log(`Nonsecret custody receipt: ${metadataFile}`)
    return receipt
  } catch (error) {
    log(`Bootstrap incomplete. Protected recovery files retained at ${scratch}`)
    log(
      'Do not rerun with new names or delete vault entries to retry. Inspect/recover this pair first.'
    )
    throw error
  } finally {
    process.umask(previousMask)
    if (complete) await rm(scratch, { recursive: true })
  }
}

async function worker() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const { command, privateKeyFile, password, proofFile } = JSON.parse(input)
  const { run } = await import('@tauri-apps/cli')
  // The password is passed to the native API in memory, never as an OS process argument.
  if (command === 'generate') {
    await run([
      'signer',
      'generate',
      '--ci',
      '--password',
      password,
      '--write-keys',
      privateKeyFile
    ])
  } else if (command === 'sign') {
    await run([
      'signer',
      'sign',
      '--private-key-path',
      privateKeyFile,
      '--password',
      password,
      proofFile
    ])
  } else throw new Error('Unsupported key worker command.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  if (process.argv[2] === '--tauri-worker') {
    worker().catch(() => {
      console.error('Tauri key worker failed; secret diagnostics suppressed.')
      process.exitCode = 1
    })
  } else {
    try {
      const args = process.argv.slice(2)
      const create = args[0] === '--create'
      assert.ok(
        create || args.length === 0,
        'Usage: node scripts/bootstrap-updater-key.mjs [--create]'
      )
      assert.ok(args.length <= 1, 'Usage: node scripts/bootstrap-updater-key.mjs [--create]')
      const publicKeyFile = path.join(ROOT, 'src-tauri/updater.pub')
      if (create) await provisionUpdaterKey({ publicKeyFile })
      else {
        vaultStore().preflight()
        console.log(`Vault and unused secret names verified in ${VAULT.name}.`)
        console.log(
          'Run again with --create to generate and upload the password and encrypted private key.'
        )
      }
    } catch (error) {
      console.error(`Updater key bootstrap failed: ${error.message}`)
      process.exitCode = 1
    }
  }
}
