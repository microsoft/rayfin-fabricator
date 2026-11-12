import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkReleaseVersion } from './check-release-version.mjs'

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'fabricator-release-version-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'src-tauri'))
  const write = (file, content) => writeFileSync(path.join(root, file), content)
  write('package.json', '{"version":"1.2.3"}')
  write('package-lock.json', '{"version":"1.2.3","packages":{"":{"version":"1.2.3"}}}')
  write('src-tauri/tauri.conf.json', '{"version":"1.2.3"}')
  write('src-tauri/Cargo.toml', '[package]\nversion = "1.2.3"\n[dependencies]\n')
  write('src-tauri/Cargo.lock', '[[package]]\nname = "rayfin-fabricator"\nversion = "1.2.3"\n')
  return { root, write }
}

test('accepts aligned application versions', (t) => {
  const { root } = fixture(t)
  assert.equal(checkReleaseVersion(root).version, '1.2.3')
  assert.equal(Object.keys(checkReleaseVersion(root).versions).length, 6)
})

test('rejects each mismatched application version', (t) => {
  const replacements = {
    'package-lock.json': '{"version":"1.2.4","packages":{"":{"version":"1.2.3"}}}',
    'package-lock.json root package': '{"version":"1.2.3","packages":{"":{"version":"1.2.4"}}}',
    'src-tauri/tauri.conf.json': '{"version":"1.2.4"}',
    'src-tauri/Cargo.toml': '[package]\nversion = "1.2.4"\n',
    'src-tauri/Cargo.lock': '[[package]]\nname = "rayfin-fabricator"\nversion = "1.2.4"\n'
  }
  for (const [file, content] of Object.entries(replacements)) {
    const { root, write } = fixture(t)
    write(file === 'package-lock.json root package' ? 'package-lock.json' : file, content)
    assert.throws(() => checkReleaseVersion(root), /does not match package.json/)
  }
})

test('rejects missing versions and duplicate application lock entries', (t) => {
  const { root, write } = fixture(t)
  write('src-tauri/Cargo.toml', '[package]\nname = "rayfin-fabricator"\n')
  assert.throws(() => checkReleaseVersion(root), /Cargo.toml has no application version/)
  write('src-tauri/Cargo.toml', '[package]\nversion = "1.2.3"\n')
  write('src-tauri/Cargo.lock', '[[package]]\nname = "another-package"\nversion = "1.2.3"\n')
  assert.throws(() => checkReleaseVersion(root), /exactly one rayfin-fabricator/)
  write(
    'src-tauri/Cargo.lock',
    '[[package]]\nname = "rayfin-fabricator"\nversion = "1.2.3"\n'.repeat(2)
  )
  assert.throws(() => checkReleaseVersion(root), /exactly one rayfin-fabricator/)
})

test('accepts CRLF files and ignores dependency versions', (t) => {
  const { root, write } = fixture(t)
  write(
    'src-tauri/Cargo.toml',
    '[package]\r\nversion = "1.2.3"\r\n[dependencies]\r\nversion = "9.9.9"\r\n'
  )
  write(
    'src-tauri/Cargo.lock',
    '[[package]]\r\nname = "other"\r\nversion = "9.9.9"\r\n[[package]]\r\nname = "rayfin-fabricator"\r\nversion = "1.2.3"\r\n'
  )
  assert.equal(checkReleaseVersion(root).version, '1.2.3')
})

test('CLI verifies the exact source commit and emits provenance', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
  const run = (expected) =>
    spawnSync(process.execPath, ['scripts/check-release-version.mjs'], {
      cwd: root,
      env: { ...process.env, BUILD_SOURCEVERSION: expected },
      encoding: 'utf8'
    })
  const success = run(sourceCommit)
  assert.equal(success.status, 0, success.stderr)
  assert.equal(JSON.parse(success.stdout).sourceCommit, sourceCommit)
  const failure = run('0'.repeat(40))
  assert.equal(failure.status, 1)
  assert.match(failure.stderr, /does not match BUILD_SOURCEVERSION/)
})
