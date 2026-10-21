/**
 * Real browser check that the Edge-served session methods answer with
 * upstream's Remote error codes: the Web client localizes a
 * `session/attachment-invalid` rejection by its reason instead of showing the
 * raw message and code.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'
import { keepFailingBrowserState } from './fixtures/browser-failure.mjs'
import { startMockDeepSeek } from './fixtures/mock-deepseek.mjs'

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4XmP4z8DwHwAFAAH/NQZ7kgAAAABJRU5ErkJggg=='

it('shows the localized copy when a text-only model is sent an image', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-remote-errors-'))
  const config = join(state, 'wrangler.json')
  const mode = process.env.DSH_EDGE_TEST_RUNTIME_MODE ?? 'direct'
  const ownerKey = 'remote-errors-fixture-owner-key-32-chars'
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
    const rpc = async (method, payload) => (await context.request.post(`${origin}/api/${method}`, {
      data: { type: 'client-request', rpcId: crypto.randomUUID(), method, payload },
    })).json()
    const page = await context.newPage()
    await page.goto(origin)
    const onboarding = page.getByRole('button', { name: 'Continue', exact: true })
    if (await onboarding.waitFor({ timeout: 5000 }).then(() => true, () => false)) await onboarding.click()
    const composer = page.getByRole('textbox').last()
    await composer.waitFor()
    // The page opens on a blank session; give it a model without image input.
    let blankSessionId
    await expect.poll(async () => {
      blankSessionId = (await rpc('session.list', {})).result.value.items.find(item => item.blank === true)?.sessionId
      return blankSessionId
    }, { timeout: 30_000 }).toBeTypeOf('string')
    const selected = await rpc('session.selectModel', { sessionId: blankSessionId, provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(selected.result.ok).toBe(true)

    await composer.evaluate((textarea, data) => {
      const png = Uint8Array.from(atob(data), character => character.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([png], 'one-pixel.png', { type: 'image/png' }))
      textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
    }, ONE_PIXEL_PNG)
    await expect.poll(() => page.getByRole('group', { name: 'Pending attachments' }).count()).toBe(1)
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    // 60 s: Windows release runs have stalled past 30 s before the Web client accepts a draft
    // (0.27.1 release run 39555631013); a failure keeps the page state for diagnosis.
    await expect.poll(async () => {
      await composer.fill('describe this image')
      return await send.isEnabled()
    }, { timeout: 60_000 }).toBe(true)
    await send.click()

    await page.getByText('The current model does not support images; switch to a model that does', { exact: true })
      .first().waitFor({ timeout: 30_000 })
    expect(await page.getByText('(session/attachment-invalid)').count()).toBe(0)
  } catch (error) {
    await keepFailingBrowserState('remote-errors', browser)
    throw error
  } finally {
    await browser?.close()
    await worker?.stop()
    await mock.close()
    rmSync(state, { recursive: true, force: true })
  }
}, 240_000)
