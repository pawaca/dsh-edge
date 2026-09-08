/** Real browser creation and delivery through the promoted Worker alarm path. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'
import { startMockDeepSeek } from './fixtures/mock-deepseek.mjs'

it('wakes a cold session for a durable reminder without a browser connection', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-schedule-browser-'))
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
    await page.goto(origin)
    const onboarding = page.getByRole('button', { name: 'Continue', exact: true })
    if (await onboarding.waitFor({ timeout: 5000 }).then(() => true, () => false)) await onboarding.click()
    const input = page.getByRole('textbox').last()
    await input.waitFor()
    const delay = Number(process.env.DSH_EDGE_SCHEDULE_IDLE_SECONDS ?? 8)
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    // The initial blank session can replace the composer during bootstrap.
    // Wait for a draft accepted by the mounted session before submitting once.
    await expect.poll(async () => {
      await input.fill(`schedule once ${delay}`)
      return await send.isEnabled()
    }, { timeout: 15_000 }).toBe(true)
    await send.click()
    await page.getByText('tool-finished', { exact: true }).first().waitFor({ timeout: 30_000 })
    expect(mock.requests.some(request => request.messages.some(message => message.role === 'tool' && message.content?.includes('scheduledAt')))).toBe(true)
    await page.close()
    // Poll the provider fixture only: no browser/HTTP request may wake the DO.
    await expect.poll(() => mock.requests.filter(request => request.messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('[SCHEDULE REMINDER]'))).length, { timeout: (delay + 30) * 1000 }).toBe(1)
    const restored = await context.newPage()
    await restored.goto(origin)
    await restored.getByText('schedule-delivered', { exact: true }).first().waitFor({ timeout: 15_000 })
    if (process.env.DSH_EDGE_SCHEDULE_SCREENSHOT) await restored.screenshot({ path: process.env.DSH_EDGE_SCHEDULE_SCREENSHOT, fullPage: true })
  } finally {
    mock.releaseSlowResponses()
    await browser?.close()
    await worker?.stop()
    await mock.close()
    rmSync(state, { recursive: true, force: true })
  }
}, 240_000)
