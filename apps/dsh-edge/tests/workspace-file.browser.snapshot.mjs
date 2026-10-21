/**
 * Real browser check of upstream's /api/file route on the Edge: a workspace
 * image an assistant message names by path loads in the chat, served from the
 * VFS as a stream.
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

const IMAGE_PATH = '/workspace/pictures/pixel.svg'
const IMAGE = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="#c0392b"/></svg>'

it('shows a workspace image named in an assistant message', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-workspace-file-'))
  const config = join(state, 'wrangler.json')
  const mode = process.env.DSH_EDGE_TEST_RUNTIME_MODE ?? 'direct'
  const ownerKey = 'workspace-file-fixture-owner-key-32'
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
    expect((await context.request.put(`${origin}/api/workspace/file?path=${IMAGE_PATH}`, { data: IMAGE })).ok()).toBe(true)
    const page = await context.newPage()
    await page.goto(origin)
    const onboarding = page.getByRole('button', { name: 'Continue', exact: true })
    if (await onboarding.waitFor({ timeout: 5000 }).then(() => true, () => false)) await onboarding.click()
    const input = page.getByRole('textbox').last()
    await input.waitFor()
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    // 60 s: Windows release runs have stalled past 30 s before the Web client accepts a draft
    // (0.27.1 release run 39555631013); a failure keeps the page state for diagnosis.
    await expect.poll(async () => {
      await input.fill(`show workspace image ${IMAGE_PATH}`)
      return await send.isEnabled()
    }, { timeout: 60_000 }).toBe(true)
    await send.click()

    const image = page.locator(`img[src*="api/file?path=${encodeURIComponent(IMAGE_PATH)}"]`).first()
    await image.waitFor({ timeout: 30_000 })
    await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth)).toBe(24)
  } catch (error) {
    await keepFailingBrowserState('workspace-file', browser)
    throw error
  } finally {
    await browser?.close()
    await worker?.stop()
    await mock.close()
    rmSync(state, { recursive: true, force: true })
  }
}, 240_000)
