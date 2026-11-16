#!/usr/bin/env node
// Copies the distribution settings (src/shared/distribution.json: where Fabricator is
// published, its docs site, its updater channel and where rayfin-local comes from) into the
// files that can't read them at build time:
//
//   src-tauri/tauri.conf.json          plugins.updater endpoint and pubkey
//   .github/ISSUE_TEMPLATE/config.yml  the troubleshooting docs and issues links
//   src/shared/advisor/rules.json      the rayfin-local documentation links
//
//   node scripts/distribution/sync.mjs [--check]
//
// --check changes nothing and fails when a copy differs, for CI. The Rust build fails too
// when tauri.conf.json's updater settings drift (src-tauri/build.rs).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONFIG_FILE = 'src/shared/distribution.json'
const REPO = /^[\w.-]+\/[\w.-]+$/

/** Reads and validates distribution.json. */
export function readConfig(root = ROOT) {
  const config = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'))
  const problems = []
  if (!REPO.test(config.repository ?? '')) problems.push('"repository" must be owner/name')
  if (!REPO.test(config.rayfinLocal?.repository ?? '')) {
    problems.push('"rayfinLocal.repository" must be owner/name')
  }
  if (!/^https:\/\/[^/\s]+(\/\S*[^/\s])?$/.test(config.docsBase ?? '')) {
    problems.push('"docsBase" must be an https URL without a trailing slash')
  }
  if (!/^https:\/\/\S+$/.test(config.updater?.endpoint ?? '')) {
    problems.push('"updater.endpoint" must be an https URL')
  }
  if (!config.updater?.pubkey) problems.push('"updater.pubkey" is required')
  if (problems.length) throw new Error(`${CONFIG_FILE}: ${problems.join('; ')}`)
  return config
}

function replaceOrThrow(text, pattern, replacement, file) {
  if (!pattern.test(text)) throw new Error(`${file}: couldn't find ${pattern}`)
  return text.replace(pattern, replacement)
}

/** Each derived file, as a function from its current text to its synced text. */
export const TARGETS = {
  // Edited in place rather than re-serialized: the file isn't in JSON.stringify's layout.
  'src-tauri/tauri.conf.json': (text, config, file) => {
    let out = replaceOrThrow(
      text,
      /("updater":\s*\{[^}]*?"pubkey":\s*)"[^"]*"/,
      `$1${JSON.stringify(config.updater.pubkey)}`,
      file
    )
    out = replaceOrThrow(
      out,
      /("updater":\s*\{[^}]*?\n([ \t]*)"endpoints":\s*\[)[^\]]*\]/,
      (_, head, indent) => `${head}\n${indent}  ${JSON.stringify(config.updater.endpoint)}\n${indent}]`,
      file
    )
    return out
  },
  '.github/ISSUE_TEMPLATE/config.yml': (text, config, file) => {
    let out = replaceOrThrow(
      text,
      /(\n\s+url: )\S+(\/docs\/troubleshooting\n)/,
      `$1${config.docsBase}$2`,
      file
    )
    out = replaceOrThrow(
      out,
      /(\n\s+url: )https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/issues\n)/,
      `$1https://github.com/${config.repository}$2`,
      file
    )
    return out
  },
  'src/shared/advisor/rules.json': (text, config) =>
    text.replace(
      /("title": "[^"]*\(rayfin-local\)", "url": "https:\/\/github\.com\/)[\w.-]+\/[\w.-]+(?=[/#"])/g,
      `$1${config.rayfinLocal.repository}`
    )
}

/** Brings every derived file in line with distribution.json. Returns the files that differed. */
export function sync(root = ROOT, { check = false } = {}) {
  const config = readConfig(root)
  const stale = []
  for (const [file, render] of Object.entries(TARGETS)) {
    const full = path.join(root, file)
    const text = fs.readFileSync(full, 'utf8')
    const synced = render(text, config, file)
    if (synced === text) continue
    stale.push(file)
    if (!check) fs.writeFileSync(full, synced)
  }
  return stale
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const unknown = args.filter((a) => a !== '--check')
  if (unknown.length) {
    console.error(`Unknown argument ${unknown[0]}. Usage: node scripts/distribution/sync.mjs [--check]`)
    process.exit(2)
  }
  const check = args.includes('--check')
  try {
    const stale = sync(ROOT, { check })
    if (check && stale.length) {
      console.error(
        `These files don't match ${CONFIG_FILE}:\n${stale.map((f) => `  ${f}`).join('\n')}\n` +
          'Run `node scripts/distribution/sync.mjs` to update them.'
      )
      process.exit(1)
    }
    console.log(
      stale.length
        ? `Updated ${stale.join(', ')} from ${CONFIG_FILE}.`
        : `Everything matches ${CONFIG_FILE}.`
    )
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
