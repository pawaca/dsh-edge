/**
 * Real browser check of the Conversation header's More menu on the Edge: in a
 * narrow window a View that does not fit the tab row stays reachable through
 * the Edge's own registration, which lists the folded Views and no plugin
 * actions (upstream's entry-customization package is not shipped).
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

it('keeps a folded Conversation View reachable from the More menu', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-conversation-views-'))
  const config = join(state, 'wrangler.json')
  const mode = process.env.DSH_EDGE_TEST_RUNTIME_MODE ?? 'direct'
  const ownerKey = 'conversation-views-fixture-owner-key-32'
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
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const origin = `http://${worker.address}:${worker.port}`
    expect((await context.request.post(`${origin}/api/auth/login`, { form: { accessKey: ownerKey } })).ok()).toBe(true)
    const page = await context.newPage()
    await page.goto(origin)
    const onboarding = page.getByRole('button', { name: 'Continue', exact: true })
    if (await onboarding.waitFor({ timeout: 5000 }).then(() => true, () => false)) await onboarding.click()
    const input = page.getByRole('textbox').last()
    await input.waitFor()
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    // 60 s, as the other browser checks: a slow runner can take long to accept a draft.
    await expect.poll(async () => {
      await input.fill('hello views')
      return await send.isEnabled()
    }, { timeout: 60_000 }).toBe(true)
    await send.click()
    const trajectoryTab = page.getByRole('tab', { name: 'Trajectory', exact: true })
    await trajectoryTab.waitFor({ timeout: 30_000 })

    // Narrow the row until only Chat fits: the header reserves 48px for More and
    // estimates 120px a tab, so a row under 288px folds Trajectory into More.
    await page.setViewportSize({ width: 320, height: 900 })
    const more = page.getByRole('button', { name: /^More conversation views/u })
    await more.waitFor({ timeout: 15_000 })
    await expect.poll(() => trajectoryTab.count()).toBe(0)
    await more.click()
    const menu = page.getByRole('menu')
    await menu.getByRole('menuitem', { name: 'Trajectory', exact: true }).waitFor()
    // Only the folded Views: no plugin browsing or Creator draft.
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['Trajectory'])
    await menu.getByRole('menuitem', { name: 'Trajectory', exact: true }).click()
    // Since rc.4 the More button keeps its plain name; the menu marks the selected View instead.
    await expect.poll(async () => {
      if (await menu.count() === 0) await more.click()
      return await menu.getByRole('menuitem', { name: 'Trajectory', exact: true }).getAttribute('aria-current')
    }, { timeout: 10_000 }).toBe('page')
  } catch (error) {
    await keepFailingBrowserState('conversation-views', browser)
    throw error
  } finally {
    await browser?.close()
    await worker?.stop()
    await mock.close()
    rmSync(state, { recursive: true, force: true })
  }
}, 240_000)
