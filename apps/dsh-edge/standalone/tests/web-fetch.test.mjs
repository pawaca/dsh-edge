import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
// Resolve from the standalone closure: the root package is deliberately unpatched.
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'

const limits = {
  maxResponseBytes: 4096,
  maxBodyChars: 4096,
  timeoutMs: 1000,
  maxRedirects: 2,
  userAgent: 'edge-fetch-regression',
}
const retrieve = (url = 'https://fixture.example/page', overrides = {}) => (
  new HttpFetchProvider({ ...limits, ...overrides }).fetch({ url })
)
afterEach(() => mock.restoreAll())

test('patched provider retrieves public HTML through platform fetch', async () => {
  const transport = mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url.href, 'https://fixture.example/page')
    assert.equal(init.redirect, 'manual')
    assert.equal(init.method, 'GET')
    assert.equal(init.headers['user-agent'], limits.userAgent)
    assert.ok(init.signal instanceof AbortSignal)
    assert.equal('dispatcher' in init, false)
    return new Response('<h1>Public page</h1>', { headers: { 'content-type': 'text/html' } })
  })
  assert.deepEqual(await retrieve(), {
    url: 'https://fixture.example/page', statusCode: 200,
    body: { kind: 'html', content: '<h1>Public page</h1>' }, truncated: false,
  })
  assert.equal(transport.mock.callCount(), 1)
})

test('follows relative same-origin redirects through platform fetch', async () => {
  const transport = mock.method(globalThis, 'fetch', async (url) => url.pathname === '/page'
    ? new Response(null, { status: 302, headers: { location: '/final' } })
    : new Response('redirect worked', { headers: { 'content-type': 'text/plain' } }))
  assert.equal((await retrieve()).body.content, 'redirect worked')
  assert.deepEqual(transport.mock.calls.map(call => call.arguments[0].href), [
    'https://fixture.example/page', 'https://fixture.example/final',
  ])
})

for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://[::1]/', 'http://metadata.internal/', 'http://service.localhost/', 'https://1.1.1.1/']) {
  test(`blocks ${url} before transport`, async () => {
    const transport = mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch') })
    await assert.rejects(retrieve(url), { code: 'WEB_BLOCKED_URL' })
    assert.equal(transport.mock.callCount(), 0)
  })
}

for (const location of ['http://127.0.0.1/private', 'https://other.example/page']) {
  test(`refuses cross-origin redirect to ${location}`, async () => {
    const transport = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302, headers: { location } }))
    await assert.rejects(retrieve(), { code: 'WEB_REDIRECT_BLOCKED' })
    assert.equal(transport.mock.callCount(), 1)
  })
}

test('preserves network failure classification', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new TypeError('network fixture failure') })
  await assert.rejects(retrieve(), error => error.code === 'WEB_PROVIDER_ERROR' && /network fixture failure/.test(error.message))
})
