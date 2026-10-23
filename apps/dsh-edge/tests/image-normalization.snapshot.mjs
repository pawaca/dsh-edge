/**
 * Image admission with the Cloudflare Images binding, through the prompt route
 * as the Web client sends images (base64 inside session.prompt): a 4K PNG is
 * stored downscaled into upstream's 2048 x 2048 pixel budget, and WebP and
 * GIF are advertised (unit tests cover their conversion). Wrangler's local Images binding is a low-fidelity version that
 * resizes and converts but does not apply EXIF orientation, so a rotated JPEG
 * shows only the upright resize box; Images in production applies the
 * orientation first (edge-image-normalization.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encode as encodePng } from 'fast-png'
import { encode as encodeJpeg } from 'jpeg-js'
import { expect, it } from 'vitest'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'
import { startMockDeepSeek } from './fixtures/mock-deepseek.mjs'

/** The bytes of an ASCII string. */
function asciiBytes(text) {
  return Array.from(text, character => character.charCodeAt(0))
}

function rotatedJpeg(width, height, orientation) {
  const plain = new Uint8Array(encodeJpeg({ width, height, data: new Uint8Array(width * height * 4).fill(120) }, 80).data)
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]
  const body = asciiBytes('Exif\0\0').concat(tiff)
  const app1 = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]
  return Uint8Array.from([...plain.subarray(0, 2), ...app1, ...plain.subarray(2)])
}

it('normalizes a 4K PNG through the Images binding and advertises upstream formats', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-image-normalization-'))
  const config = join(state, 'wrangler.json')
  const ownerKey = 'image-normalization-fixture-owner-key-32'
  const mock = await startMockDeepSeek()
  let worker
  try {
    await writePrebuiltModeWranglerConfig('direct', config, { enableImages: true })
    worker = await unstable_dev(workerArtifactPath('direct'), {
      config, persistTo: state,
      vars: { DSH_EDGE_ACCESS_KEY: ownerKey, DEEPSEEK_API_KEY: 'local-fixture-only', DEEPSEEK_BASE_URL: mock.url },
      logLevel: 'error',
      experimental: { disableExperimentalWarning: true, showInteractiveDevSession: false, watch: false },
    })
    const login = await worker.fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `accessKey=${ownerKey}`, redirect: 'manual',
    })
    const cookie = (login.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ')
    const rpc = async (method, payload) => (await (await worker.fetch(`/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    })).json()).result
    // The advertised limits follow the binding.
    const preset = (await rpc('agentPreset.read', { agentPreset: 'standard' })).value.content
    expect(preset).toMatch(/mediaTypes: "image\/png,image\/jpeg,image\/webp,image\/gif"/u)
    /** Send one image in a prompt and return the stored reference from the session's user message. */
    const store = async (mediaType, bytes, name) => {
      const sessionId = (await rpc('session.create', {})).value.sessionId
      expect((await rpc('session.selectModel', { sessionId, provider: 'deepseek-official', model: 'deepseek-flash' })).ok).toBe(true)
      const prompted = await rpc('session.prompt', {
        sessionId, mode: 'queue',
        content: [{ type: 'text', text: 'describe image' }, { type: 'image', mediaType, data: Buffer.from(bytes).toString('base64'), name }],
      })
      expect(prompted.ok, JSON.stringify(prompted)).toBe(true)
      let ref
      await expect.poll(async () => {
        const events = (await rpc('session.history', { sessionId })).value?.events ?? []
        ref = events.map(entry => entry.event).find(event => event.type === 'user/message'
          && event.data.content.some(block => block.type === 'image'))?.data.content.find(block => block.type === 'image').attachment
        return ref !== undefined
      }, { timeout: 30_000 }).toBe(true)
      const read = await rpc('session.attachment', { sessionId, attachmentId: ref.attachmentId })
      expect(read.ok, JSON.stringify(read)).toBe(true)
      return ref
    }
    const width = 3840
    const height = 2160
    const pixels = new Uint8Array(width * height * 3)
    for (let offset = 0; offset < pixels.length; offset += 3) pixels.set([(offset / 3) % 256, 80, 160], offset)
    const fourK = await store('image/png', encodePng({ width, height, data: pixels, channels: 3 }), '4k.png')
    // An opaque RGB PNG becomes JPEG inside the 2048 x 2048 budget.
    expect(fourK).toMatchObject({ mediaType: 'image/jpeg', width: 2730, height: 1536, originalDimensions: { width: 3840, height: 2160 } })
    expect(fourK.bytes).toBeLessThanOrEqual(4 * 1024 * 1024)

    // The resize box is on the upright axes (300 x 400). Images in production turns the
    // image first and keeps it whole; the local binding does not turn, so it fits the
    // unturned 400 x 300 into that box.
    const rotated = await store('image/jpeg', rotatedJpeg(400, 300, 6), 'rotated.jpg')
    expect(rotated).toMatchObject({ mediaType: 'image/jpeg', width: 300, height: 225, originalDimensions: { width: 400, height: 300 } })
  } finally {
    await worker?.stop()
    await mock.close()
    rmSync(state, { recursive: true, force: true })
  }
}, 240_000)
