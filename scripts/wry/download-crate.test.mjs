import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { downloadCrate } from './download-crate.mjs'

const archive = Buffer.from('crate archive fixture')
const checksum = createHash('sha256').update(archive).digest('hex')
const index = 'https://feed.example/Cargo/index/'

function sparseFeed(t, { dl = 'https://feed.example/Cargo/api', cksum = checksum } = {}) {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const href = String(url)
    requests.push({ href, headers: options.headers })
    if (href === `${index}config.json`) return Response.json({ dl })
    if (href === `${index}3/w/wry`) {
      return new Response(
        [
          JSON.stringify({ name: 'wry', vers: '0.56.0', cksum: '0'.repeat(64) }),
          JSON.stringify({ name: 'wry', vers: '0.57.0', cksum })
        ].join('\n')
      )
    }
    return new Response(archive)
  })
  return requests
}

test('downloads the exact pinned crate through an authenticated sparse registry', async (t) => {
  const requests = sparseFeed(t)
  assert.deepEqual(
    await downloadCrate('wry', '0.57.0', { index: `sparse+${index}`, token: 'Bearer fixture' }),
    archive
  )
  assert.deepEqual(
    requests.map((request) => request.href),
    [`${index}config.json`, `${index}3/w/wry`, 'https://feed.example/Cargo/api/wry/0.57.0/download']
  )
  assert.ok(requests.every((request) => request.headers.Authorization === 'Bearer fixture'))
})

test('supports download templates without leaking feed credentials to another origin', async (t) => {
  const requests = sparseFeed(t, {
    dl: 'https://archive.example/{prefix}/{crate}/{version}/{sha256-checksum}.crate'
  })
  await downloadCrate('wry', '0.57.0', { index, token: 'Bearer fixture' })
  assert.equal(requests.at(-1).href, `https://archive.example/3/w/wry/0.57.0/${checksum}.crate`)
  assert.equal(requests.at(-1).headers.Authorization, undefined)
})

test('rejects altered archives, missing versions, and feed failures without public fallback', async (t) => {
  const requests = sparseFeed(t, { cksum: '0'.repeat(64) })
  await assert.rejects(downloadCrate('wry', '0.57.0', { index }), /Checksum mismatch/)
  await assert.rejects(downloadCrate('wry', '0.58.0', { index }), /is missing/)
  assert.ok(requests.every((request) => new URL(request.href).origin === new URL(index).origin))
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }))
  await assert.rejects(downloadCrate('wry', '0.57.0', { index }), /HTTP 403/)
})

test('preserves checksum verification for the default public crates.io route', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), headers: options.headers })
    return String(url).startsWith('https://crates.io/api/')
      ? Response.json({ version: { checksum, yanked: false } })
      : new Response(archive)
  })
  assert.deepEqual(await downloadCrate('wry', '0.57.0'), archive)
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      'https://crates.io/api/v1/crates/wry/0.57.0',
      'https://static.crates.io/crates/wry/wry-0.57.0.crate'
    ]
  )
})
