import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ensureUnused,
  provisionUpdaterKey,
  SECRETS,
  VAULT,
  vaultStore,
  verifyProof
} from './bootstrap-updater-key.mjs'

const SCRIPT = fileURLToPath(new URL('./bootstrap-updater-key.mjs', import.meta.url))
const URI = `https://${VAULT.name}.vault.azure.net/`
const VAULT_ID = `/subscriptions/${VAULT.subscription}/resourceGroups/${VAULT.resourceGroup}/providers/Microsoft.KeyVault/vaults/${VAULT.name}`

test('preflight rejects existing and soft-deleted key material without creating new versions', () => {
  for (const name of Object.values(SECRETS)) {
    assert.throws(() => ensureUnused([{ name }], []), /Refusing to replace/)
    assert.throws(() => ensureUnused([], [{ name }]), /Refusing to replace/)
  }
  const calls = []
  const store = vaultStore((args) => {
    calls.push(args)
    if (args[1] === 'show') return JSON.stringify({ id: VAULT_ID, uri: URI })
    if (args[2] === 'list') return JSON.stringify([{ name: SECRETS.password }])
    return '[]'
  })
  assert.throws(() => store.preflight(), /Refusing to replace/)
  assert.ok(calls.every((args) => !args.includes('set')))
})

test('Azure upload uses a file and returns only a versioned ID, never a secret value', () => {
  const calls = []
  const id = `${URI}secrets/${SECRETS.password}/${'a'.repeat(32)}`
  const store = vaultStore((args) => {
    calls.push(args)
    return JSON.stringify(id)
  })
  assert.equal(store.upload(SECRETS.password, '/protected/password'), id)
  assert.ok(calls[0].includes('--file'))
  assert.ok(!calls[0].includes('--value'))
  assert.equal(calls[0].at(-1), 'id')
  store.download(id, '/protected/readback')
  assert.ok(calls[1].includes(id), 'Readback must use the exact returned version.')
})

test('real Tauri keys round-trip through storage and verify with the public key', async (t) => {
  if (process.platform === 'win32') return t.skip('Bootstrap requires POSIX file protection.')
  const root = await mkdtemp(path.join(os.tmpdir(), 'fabricator-key-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const publicKeyFile = path.join(root, 'updater.pub')
  const values = new Map()
  const events = []
  const logs = []
  let scratch
  const store = {
    preflight: () => ({ uri: URI, purgeProtection: true }),
    async upload(name, file) {
      events.push(`upload:${name}`)
      scratch = path.dirname(file)
      assert.equal((await stat(scratch)).mode & 0o777, 0o700)
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      const contents = await readFile(file)
      if (name === SECRETS.password) {
        assert.match(contents.toString(), /^[A-Za-z0-9_-]{64}$/)
        assert.ok(!existsSync(path.join(scratch, 'updater.key')))
      }
      const id = `${URI}secrets/${name}/${'a'.repeat(32)}`
      values.set(id, contents)
      return id
    },
    async download(id, file) {
      events.push(`download:${id.split('/')[4]}`)
      await writeFile(file, values.get(id), { mode: 0o600, flag: 'wx' })
    }
  }
  const receipt = await provisionUpdaterKey({
    publicKeyFile,
    store,
    log: (line) => logs.push(line)
  })
  assert.equal(receipt.verifiedRoundTrip, true)
  assert.deepEqual(events, [
    `upload:${SECRETS.password}`,
    `download:${SECRETS.password}`,
    `upload:${SECRETS.privateKey}`,
    `download:${SECRETS.privateKey}`
  ])
  assert.ok(!existsSync(scratch), 'Successful bootstrap removes local secret files.')
  for (const value of values.values()) {
    assert.ok(!logs.join('\n').includes(value.toString()))
    assert.ok(!(await readFile(`${publicKeyFile}.vault.json`, 'utf8')).includes(value.toString()))
  }
  const keyFile = path.join(root, 'restore.key')
  const dataFile = path.join(root, 'artifact')
  const password = values.get(receipt.passwordSecretId).toString()
  await writeFile(keyFile, values.get(receipt.privateKeySecretId), { mode: 0o600 })
  await writeFile(dataFile, 'artifact bytes')
  const run = (password) =>
    spawnSync(process.execPath, [SCRIPT, '--tauri-worker'], {
      input: JSON.stringify({
        command: 'sign',
        privateKeyFile: keyFile,
        password,
        proofFile: dataFile
      }),
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' }
    })
  const wrongPassword = run('wrong password')
  assert.notEqual(wrongPassword.status, 0)
  assert.ok(!existsSync(`${dataFile}.sig`))
  const signed = run(password)
  assert.equal(signed.status, 0, signed.stderr)
  const publicKey = await readFile(publicKeyFile, 'utf8')
  const signature = await readFile(`${dataFile}.sig`, 'utf8')
  verifyProof(publicKey, signature, Buffer.from('artifact bytes'))
  assert.throws(() => verifyProof(publicKey, signature, Buffer.from('tampered')), /did not verify/)
  const decoded = Buffer.from(signature, 'base64').toString('utf8')
  const tampered = Buffer.from(decoded.replace('timestamp:', 'timestamp:0')).toString('base64')
  assert.throws(() => verifyProof(publicKey, tampered, Buffer.from('artifact bytes')), /comment/)
  assert.ok(!signed.stdout.includes(password))
  assert.ok(!signed.stdout.includes(values.get(receipt.privateKeySecretId).toString()))
  await assert.rejects(provisionUpdaterKey({ publicKeyFile, store }), /already exists/)
})

test('failed uploads retain protected recovery files and do not generate or overwrite a key', async (t) => {
  if (process.platform === 'win32') return t.skip('Bootstrap requires POSIX file protection.')
  const root = await mkdtemp(path.join(os.tmpdir(), 'fabricator-key-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logs = []
  let generated = false
  const store = {
    preflight: () => ({ uri: URI, purgeProtection: true }),
    upload: () => {
      throw new Error('upload interrupted')
    }
  }
  await assert.rejects(
    provisionUpdaterKey({
      publicKeyFile: path.join(root, 'updater.pub'),
      store,
      generate: () => {
        generated = true
      },
      log: (line) => logs.push(line)
    }),
    /upload interrupted/
  )
  const recovery = logs
    .find((line) => line.startsWith('Bootstrap incomplete.'))
    .split('retained at ')[1]
  assert.ok(path.basename(recovery).startsWith('fabricator-updater-bootstrap-'))
  t.after(() => rm(recovery, { recursive: true, force: true }))
  assert.equal((await stat(recovery)).mode & 0o777, 0o700)
  assert.equal((await stat(path.join(recovery, 'password'))).mode & 0o777, 0o600)
  assert.equal(generated, false)
  assert.ok(!existsSync(path.join(root, 'updater.pub')))
})

test('unknown arguments never start provisioning', () => {
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--force'], { stdio: 'pipe' }))
})
