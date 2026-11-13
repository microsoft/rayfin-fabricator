import { createHash } from 'node:crypto'

const USER_AGENT = 'rayfin-fabricator vendor-wry (https://github.com/spatney/rayfin-fabricator)'

export async function downloadCrate(name, version, { index, token } = {}) {
  const registry = index ? new URL(index.replace(/^sparse\+/, '')) : null
  if (
    registry &&
    (registry.protocol !== 'https:' ||
      !registry.pathname.endsWith('/') ||
      registry.username ||
      registry.password)
  ) {
    throw new Error('Cargo index must be an HTTPS URL ending in / without embedded credentials')
  }
  async function get(url) {
    const headers = { 'User-Agent': USER_AGENT }
    if (token && new URL(url).origin === registry?.origin) headers.Authorization = token
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response
    } catch (error) {
      throw new Error(`Couldn't download ${url}: ${error.cause?.message ?? error.message}`, {
        cause: error
      })
    }
  }

  let checksum, yanked, url
  if (registry) {
    const lower = name.toLowerCase()
    const prefix =
      lower.length < 3
        ? String(lower.length)
        : lower.length === 3
          ? `3/${lower[0]}`
          : `${lower.slice(0, 2)}/${lower.slice(2, 4)}`
    const config = await (await get(new URL('config.json', registry))).json()
    const records = await (await get(new URL(`${prefix}/${lower}`, registry))).text()
    const metadata = records
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((record) => record.name === name && record.vers === version)
    if (!metadata) throw new Error(`${name} ${version} is missing from ${registry}`)
    checksum = metadata.cksum
    yanked = metadata.yanked
    if (typeof config.dl !== 'string' || !config.dl) {
      throw new Error(`Missing crate download URL in ${registry}`)
    }
    url = config.dl.includes('{')
      ? config.dl
          .replaceAll('{crate}', name)
          .replaceAll('{version}', version)
          .replaceAll('{prefix}', prefix)
          .replaceAll('{lowerprefix}', prefix)
          .replaceAll('{sha256-checksum}', checksum)
      : `${config.dl.replace(/\/$/, '')}/${name}/${version}/download`
  } else {
    const metadata = await (await get(`https://crates.io/api/v1/crates/${name}/${version}`)).json()
    checksum = metadata.version.checksum
    yanked = metadata.version.yanked
    url = `https://static.crates.io/crates/${name}/${name}-${version}.crate`
  }
  if (!/^[0-9a-f]{64}$/.test(checksum ?? '')) {
    throw new Error(`Missing or invalid checksum for ${name} ${version}`)
  }
  if (yanked) console.warn(`warning: ${name} ${version} is yanked on the registry`)
  const archive = Buffer.from(await (await get(url)).arrayBuffer())
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== checksum) {
    throw new Error(`Checksum mismatch for ${url}: expected ${checksum}, got ${actual}`)
  }
  return archive
}
