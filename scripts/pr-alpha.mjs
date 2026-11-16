#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY = 'microsoft/rayfin-fabricator'

export function validateOptIn(pr, events, reviews, commit) {
  assert.equal(pr.state, 'open', 'PR must be open.')
  assert.equal(pr.head.repo.full_name, REPOSITORY, 'Fork release builds are not allowed.')
  assert.equal(pr.base.repo.full_name, REPOSITORY)
  assert.equal(pr.base.ref, 'main')
  assert.equal(pr.head.sha, commit, 'PR head changed; queue its exact current commit.')
  assert.ok(
    pr.labels.some(({ name }) => name === 'release-test'),
    'Missing release-test label.'
  )
  const optIn = events.findLast(
    (event) => event.event === 'labeled' && event.label?.name === 'release-test'
  )
  const actor = optIn?.actor?.login
  assert.ok(
    actor &&
      (actor === pr.user.login ||
        reviews.some((review) => review.user.login === actor && review.state !== 'PENDING')),
    'The release-test label must be applied by the PR author or a submitted reviewer.'
  )
}

export async function checkOptIn(number, commit, request = fetch) {
  assert.match(String(number), /^[1-9]\d*$/, 'Provide a positive PR number.')
  assert.match(commit, /^[0-9a-f]{40}$/)
  const get = async (route) => {
    const response = await request(`https://api.github.com/repos/${REPOSITORY}/${route}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    })
    if (!response.ok) throw new Error(`GitHub PR authorization failed: HTTP ${response.status}.`)
    return response.json()
  }
  const list = async (route) => {
    const result = []
    for (let page = 1; ; page++) {
      const batch = await get(`${route}?per_page=100&page=${page}`)
      assert.ok(Array.isArray(batch), 'Unexpected GitHub list response.')
      result.push(...batch)
      if (batch.length < 100) return result
    }
  }
  const [pr, events, reviews] = await Promise.all([
    get(`pulls/${number}`),
    list(`issues/${number}/events`),
    list(`pulls/${number}/reviews`)
  ])
  validateOptIn(pr, events, reviews, commit)
}

export function alphaVersion(base, buildId) {
  assert.match(
    base,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    'Expected a stable base version.'
  )
  assert.match(String(buildId), /^[1-9]\d*$/, 'Expected an ADO build ID.')
  return `${base}-alpha.${buildId}`
}

export async function prepareAlpha(root, buildId) {
  const { checkReleaseVersion } = await import('./check-release-version.mjs')
  const { version: base } = checkReleaseVersion(root)
  const version = alphaVersion(base, buildId)
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
    const filename = path.join(root, file)
    const data = JSON.parse(await readFile(filename, 'utf8'))
    data.version = version
    if (file === 'package-lock.json') data.packages[''].version = version
    if (file === 'src-tauri/tauri.conf.json') data.bundle.createUpdaterArtifacts = false
    await writeFile(filename, `${JSON.stringify(data, null, 2)}\n`)
  }
  for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    const filename = path.join(root, file)
    const text = await readFile(filename, 'utf8')
    const updated = text
      .split(/(?=^\[)/m)
      .map((block) =>
        (file.endsWith('Cargo.toml') && block.startsWith('[package]')) ||
        (block.startsWith('[[package]]') && /^name = "rayfin-fabricator"\r?$/m.test(block))
          ? block.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`)
          : block
      )
      .join('')
    await writeFile(filename, updated)
  }
  assert.equal(checkReleaseVersion(root).version, version)
  return version
}

export async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifyRelease(folder, { commit, buildId, pr }) {
  const metadata = JSON.parse(await readFile(path.join(folder, 'windows-alpha.json'), 'utf8'))
  assert.equal(metadata.sourceCommit, commit)
  assert.equal(metadata.buildId, String(buildId))
  assert.equal(metadata.pullRequest, Number(pr))
  assert.match(metadata.version, new RegExp(`^\\d+\\.\\d+\\.\\d+-alpha\\.${buildId}$`))
  const archive = `rayfin-fabricator-${metadata.version}-windows-x64.zip`
  const installerName = `Rayfin Fabricator_${metadata.version}_x64-setup.exe`
  assert.equal(metadata.archive, archive)
  assert.equal(await sha256(path.join(folder, archive)), metadata.archiveSha256)
  const installer = metadata.installer.installer
  assert.equal(installer.path, installerName)
  assert.equal(await sha256(path.join(folder, installerName)), installer.sha256)
  assert.equal(installer.authenticode.status, 'Valid')
  assert.ok(installer.authenticode.timestampSubject)
  assert.match(installer.authenticode.signerSubject, /(?:^|,\s*)O=Microsoft Corporation(?:,|$)/)
  assert.equal(metadata.installer.signedInputsUnchanged, true)
  assert.ok(installer.aslr.fixups > 0)
  assert.equal(metadata.installer.nsis.reproducible, true)
  assert.equal(metadata.installer.installVerification.relocatedInstaller, true)
  assert.equal(metadata.installer.installVerification.signedUninstaller, true)
  assert.equal(metadata.installer.installVerification.uninstall, true)
  assert.deepEqual(
    (await readFile(path.join(folder, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/),
    [`${metadata.archiveSha256}  ${archive}`, `${installer.sha256}  ${installerName}`]
  )
  assert.equal(metadata.signing.originalPayloadsUnchanged, true)
  assert.equal(metadata.signing.sourceCommit, commit)
  assert.equal(metadata.signing.files.length, 2)
  for (const [name, keyCode] of [
    ['rayfin-fabricator.exe', 'CP-230012'],
    ['rayfin-local.exe', 'CP-231522']
  ]) {
    const file = metadata.signing.files.find((entry) => entry.path === name)
    assert.equal(file?.keyCode, keyCode)
    assert.equal(file.authenticode.status, 'Valid')
    assert.ok(file.authenticode.timestampSubject)
    assert.match(file.authenticode.signerSubject, /(?:^|,\s*)O=Microsoft Corporation(?:,|$)/)
  }
  return metadata
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, folder] = process.argv.slice(2)
    const {
      BUILD_REASON,
      BUILD_SOURCEBRANCH,
      BUILD_SOURCEVERSION,
      BUILD_BUILDID,
      TEST_RELEASE_PR
    } = process.env
    assert.equal(BUILD_REASON, 'Manual', 'PR alpha releases require an authorized manual run.')
    assert.match(BUILD_SOURCEBRANCH, /^refs\/heads\//)
    await checkOptIn(TEST_RELEASE_PR, BUILD_SOURCEVERSION)
    if (command === 'prepare') {
      const version = await prepareAlpha(folder, BUILD_BUILDID)
      console.log(`##vso[task.setvariable variable=ReleaseVersion]${version}`)
    } else if (command === 'verify') {
      await verifyRelease(folder, {
        commit: BUILD_SOURCEVERSION,
        buildId: BUILD_BUILDID,
        pr: TEST_RELEASE_PR
      })
    } else throw new Error('Expected prepare or verify command.')
  } catch (error) {
    console.error(`PR alpha release failed: ${error.message}`)
    process.exitCode = 1
  }
}
