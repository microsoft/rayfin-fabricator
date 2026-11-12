#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function checkReleaseVersion(root = ROOT) {
  const read = (file) => readFileSync(path.join(root, file), 'utf8')
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  const tauri = JSON.parse(read('src-tauri/tauri.conf.json'))
  const cargo = read('src-tauri/Cargo.toml')
    .split(/(?=^\[)/m)
    .find((block) => block.startsWith('[package]'))
  const cargoLock = read('src-tauri/Cargo.lock')
    .split(/(?=^\[\[package\]\])/m)
    .filter((block) => /^name = "rayfin-fabricator"\r?$/m.test(block))

  if (cargoLock.length !== 1) {
    throw new Error('Cargo.lock must contain exactly one rayfin-fabricator package.')
  }
  const tomlVersion = (block) => block?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1]
  const versions = {
    'package.json': pkg.version,
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages?.['']?.version,
    'src-tauri/tauri.conf.json': tauri.version,
    'src-tauri/Cargo.toml': tomlVersion(cargo),
    'src-tauri/Cargo.lock': tomlVersion(cargoLock[0])
  }

  for (const [file, version] of Object.entries(versions)) {
    if (typeof version !== 'string' || !version.trim()) {
      throw new Error(`${file} has no application version.`)
    }
    if (version !== pkg.version) {
      throw new Error(`${file} version ${version} does not match package.json ${pkg.version}.`)
    }
  }
  return { version: pkg.version, versions }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkReleaseVersion()
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8'
    }).trim()
    if (process.env.BUILD_SOURCEVERSION && sourceCommit !== process.env.BUILD_SOURCEVERSION) {
      throw new Error(`Checked-out commit ${sourceCommit} does not match BUILD_SOURCEVERSION.`)
    }
    console.log(JSON.stringify({ ...result, sourceCommit }, null, 2))
  } catch (error) {
    console.error(`Release validation failed: ${error.message}`)
    process.exitCode = 1
  }
}
