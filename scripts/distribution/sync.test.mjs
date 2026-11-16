import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sync, TARGETS } from './sync.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONFIG = 'src/shared/distribution.json'

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'fabricator-distribution-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const file of [CONFIG, ...Object.keys(TARGETS)]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    cpSync(path.join(ROOT, file), path.join(root, file))
  }
  const read = (file) => readFileSync(path.join(root, file), 'utf8')
  const configure = (change) => {
    const config = JSON.parse(read(CONFIG))
    change(config)
    writeFileSync(path.join(root, CONFIG), JSON.stringify(config, null, 2))
  }
  return { root, read, configure }
}

test('the repository is in sync', () => {
  assert.deepEqual(sync(ROOT, { check: true }), [])
})

test('copies new hosting into every derived file', (t) => {
  const { root, read, configure } = fixture(t)
  const before = Object.fromEntries(Object.keys(TARGETS).map((f) => [f, read(f)]))
  configure((c) => {
    c.repository = 'contoso/fabricator'
    c.docsBase = 'https://docs.contoso.example/fabricator'
    c.updater = { endpoint: 'https://updates.contoso.example/latest.json', pubkey: 'NEWKEY' }
    c.rayfinLocal = { repository: 'contoso/rayfin-local-fork' }
  })

  assert.deepEqual(sync(root, { check: true }).sort(), Object.keys(TARGETS).sort())
  assert.equal(read('src-tauri/tauri.conf.json'), before['src-tauri/tauri.conf.json'], '--check writes nothing')
  sync(root)
  assert.deepEqual(sync(root, { check: true }), [])

  const updater = JSON.parse(read('src-tauri/tauri.conf.json')).plugins.updater
  assert.deepEqual(updater, { pubkey: 'NEWKEY', requireSignedVersion: true, endpoints: ['https://updates.contoso.example/latest.json'] })
  const template = read('.github/ISSUE_TEMPLATE/config.yml')
  assert.match(template, /url: https:\/\/docs\.contoso\.example\/fabricator\/docs\/troubleshooting\n/)
  assert.match(template, /url: https:\/\/github\.com\/contoso\/fabricator\/issues\n/)
  const rules = read('src/shared/advisor/rules.json')
  assert.doesNotThrow(() => JSON.parse(rules))
  assert.doesNotMatch(rules, /github\.com\/spatney\/rayfin-local/)
  assert.match(rules, /github\.com\/contoso\/rayfin-local-fork\/blob\/main\/docs\/seed-data\.md/)
  assert.match(rules, /github\.com\/contoso\/rayfin-local-fork#local-state-and-reset/)
})

test('rejects an invalid configuration', (t) => {
  const { root, configure } = fixture(t)
  configure((c) => {
    c.docsBase = 'http://docs.example/'
    c.rayfinLocal.repository = 'not a repo'
  })
  assert.throws(() => sync(root), /docsBase.*rayfinLocal|rayfinLocal.*docsBase/)
})
