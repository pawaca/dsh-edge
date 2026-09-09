/** Regression: a parked browser must reconnect when HTTP wakes its hibernated DO. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'
import { startMockDeepSeek } from './fixtures/mock-deepseek.mjs'

it('restores live browser subscriptions after an idle DO wakes for a prompt', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-remote-idle-'))
  const config = join(state, 'wrangler.json')
  const mode = process.env.DSH_EDGE_TEST_RUNTIME_MODE ?? 'direct'
  const ownerKey = 'idle-browser-fixture-owner-key-32-bytes'
  const mock = await startMockDeepSeek()
  let worker, browser
  try {
    await writePrebuiltModeWranglerConfig(mode, config)
    worker = await unstable_dev(workerArtifactPath(mode), {
      config, env: mode === 'direct' ? '' : 'isolated', persistTo: state,
      vars: { DSH_EDGE_ACCESS_KEY: ownerKey, DEEPSEEK_API_KEY: 'local-fixture-only', DEEPSEEK_BASE_URL: mock.url },
      logLevel: 'error',
      experimental: { disableExperimentalWarning: true, showInteractiveDevSession: false, watch: false },
    })
    browser = await chromium.launch(process.env.DSH_EDGE_PLAYWRIGHT_CHANNEL ? { channel: process.env.DSH_EDGE_PLAYWRIGHT_CHANNEL } : {})
    const context = await browser.newContext()
    const origin = `http://${worker.address}:${worker.port}`
    expect((await context.request.post(`${origin}/api/auth/login`, { form: { accessKey: ownerKey } })).ok()).toBe(true)
    const page = await context.newPage()
    let carrierCloses = 0
    page.on('websocket', socket => {
      if (socket.url().endsWith('/api/remote.mux')) socket.on('close', () => { carrierCloses++ })
    })
    await page.goto(origin)
    const onboarding = page.getByRole('button', { name: 'Continue', exact: true })
    if (await onboarding.waitFor({ timeout: 5000 }).then(() => true, () => false)) await onboarding.click()
    const input = page.getByRole('textbox').last()
    await input.waitFor()
    // Local workerd needs a genuinely idle period to evict the JS owner while
    // preserving its accepted WebSockets. Do not poll the DO during this wait.
    const beforeIdle = carrierCloses
    await page.waitForTimeout(150_000)
    await input.fill('hello after idle')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByRole('paragraph').filter({ hasText: 'remembered-alpha' }).waitFor({ timeout: 30_000 })
    expect(carrierCloses).toBeGreaterThan(beforeIdle)
    expect(mock.requests.some(request => request.messages.some(message => message.content === 'hello after idle'))).toBe(true)
  } finally {
    mock.releaseSlowResponses()
    await browser?.close()
    await worker?.stop()
    await mock.close()
    rmSync(state, { recursive: true, force: true })
  }
}, 240_000)
