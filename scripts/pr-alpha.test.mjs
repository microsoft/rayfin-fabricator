import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkReleaseVersion } from './check-release-version.mjs'
import {
  alphaVersion,
  checkOptIn,
  prepareAlpha,
  sha256,
  validateOptIn,
  verifyRelease
} from './pr-alpha.mjs'

const commit = 'a'.repeat(40)
function authorization() {
  return {
    pr: {
      state: 'open',
      head: { repo: { full_name: 'microsoft/rayfin-fabricator' }, sha: commit },
      base: { repo: { full_name: 'microsoft/rayfin-fabricator' }, ref: 'main' },
      labels: [{ name: 'release-test' }],
      user: { login: 'author' }
    },
    events: [{ event: 'labeled', label: { name: 'release-test' }, actor: { login: 'author' } }],
    reviews: [{ user: { login: 'reviewer' }, state: 'APPROVED' }]
  }
}

test('requires a current same-repo PR with an author or reviewer label opt-in', () => {
  const { pr, events, reviews } = authorization()
  validateOptIn(pr, events, reviews, commit)
  events[0].actor.login = 'reviewer'
  validateOptIn(pr, events, reviews, commit)
  for (const mutate of [
    ({ pr }) => (pr.state = 'closed'),
    ({ pr }) => (pr.head.sha = 'b'.repeat(40)),
    ({ pr }) => (pr.head.repo.full_name = 'fork/repo'),
    ({ pr }) => (pr.base.ref = 'not-main'),
    ({ pr }) => (pr.labels = []),
    ({ events }) => (events[0].actor.login = 'unrelated-collaborator'),
    ({ events }) => (events.length = 0),
    ({ events, reviews }) => {
      events[0].actor.login = 'reviewer'
      reviews[0].state = 'PENDING'
    }
  ]) {
    const data = authorization()
    mutate(data)
    assert.throws(() => validateOptIn(data.pr, data.events, data.reviews, commit))
  }
})

test('uses the latest label actor across paginated events and fails closed on API errors', async () => {
  const { pr, events, reviews } = authorization()
  const request = async (url) => ({
    ok: true,
    json: async () => {
      if (url.includes('/events?')) {
        return url.endsWith('page=1') ? Array(100).fill({ event: 'unlabeled' }) : events
      }
      if (url.includes('/reviews?')) return reviews
      return pr
    }
  })
  await checkOptIn(42, commit, request)
  events.push({ event: 'labeled', label: { name: 'release-test' }, actor: { login: 'outsider' } })
  await assert.rejects(checkOptIn(42, commit, request), /author or a submitted reviewer/)
  await assert.rejects(
    checkOptIn(42, commit, async () => ({ ok: false, status: 403 })),
    /HTTP 403/
  )
})

test('versions only application manifests and preserves dependency versions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fabricator-alpha-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'src-tauri'))
  const files = {
    'package.json': '{"version":"1.55.0"}',
    'package-lock.json':
      '{"version":"1.55.0","packages":{"":{"version":"1.55.0"},"node_modules/other":{"version":"1.55.0"}}}',
    'src-tauri/tauri.conf.json': '{"version":"1.55.0","bundle":{"createUpdaterArtifacts":true}}',
    'src-tauri/Cargo.toml': '[package]\nversion = "1.55.0"\n[dependencies]\nother = "1.55.0"\n',
    'src-tauri/Cargo.lock':
      '[[package]]\nname = "other"\nversion = "1.55.0"\n[[package]]\nname = "rayfin-fabricator"\nversion = "1.55.0"\n'
  }
  await Promise.all(
    Object.entries(files).map(([name, text]) => writeFile(path.join(root, name), text))
  )
  assert.equal(await prepareAlpha(root, '21430000'), '1.55.0-alpha.21430000')
  assert.equal(checkReleaseVersion(root).version, '1.55.0-alpha.21430000')
  assert.match(
    await readFile(path.join(root, 'src-tauri/Cargo.lock'), 'utf8'),
    /name = "other"\nversion = "1.55.0"/
  )
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
  assert.equal(lock.packages['node_modules/other'].version, '1.55.0')
  const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  assert.equal(config.bundle.createUpdaterArtifacts, false)
  for (const [base, build] of [
    ['1.2.3-beta.1', '123'],
    ['1.2.3', '0'],
    ['1.2.3', '1\ninjected']
  ]) {
    assert.throws(() => alphaVersion(base, build))
  }
})

test('publication refuses tampered archives, wrong build/PR and unsigned metadata', async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'fabricator-alpha-release-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const archive = 'rayfin-fabricator-1.55.0-alpha.123-windows-x64.zip'
  await writeFile(path.join(folder, archive), 'test archive')
  const hash = await sha256(path.join(folder, archive))
  const metadata = {
    sourceCommit: commit,
    buildId: '123',
    pullRequest: 42,
    version: '1.55.0-alpha.123',
    archive,
    archiveSha256: hash,
    signing: {
      sourceCommit: commit,
      originalPayloadsUnchanged: true,
      files: [
        ['rayfin-fabricator.exe', 'CP-230012'],
        ['rayfin-local.exe', 'CP-231522']
      ].map(([path, keyCode]) => ({
        path,
        keyCode,
        authenticode: {
          status: 'Valid',
          timestampSubject: 'CN=Microsoft Time-Stamp Service',
          signerSubject: 'O=Microsoft Corporation, C=US'
        }
      }))
    }
  }
  await writeFile(path.join(folder, 'SHA256SUMS.txt'), `${hash}  ${archive}\n`)
  const options = { commit, buildId: '123', pr: 42 }
  const save = (data) => writeFile(path.join(folder, 'windows-alpha.json'), JSON.stringify(data))
  await save(metadata)
  await verifyRelease(folder, options)
  for (const mutate of [
    (data) => (data.sourceCommit = 'b'.repeat(40)),
    (data) => (data.buildId = '124'),
    (data) => (data.pullRequest = 43),
    (data) => (data.signing.sourceCommit = 'b'.repeat(40)),
    (data) => (data.signing.files[0].authenticode.status = 'NotSigned'),
    (data) => (data.archiveSha256 = 'tampered')
  ]) {
    const data = structuredClone(metadata)
    mutate(data)
    await save(data)
    await assert.rejects(verifyRelease(folder, options))
  }
  await save(metadata)
  await writeFile(path.join(folder, archive), 'modified after signing')
  await assert.rejects(verifyRelease(folder, options))
})
