/**
 * Real browser check that an open Settings page follows a key saved or removed
 * elsewhere: the Edge credential provider announces each committed write as
 * upstream's `credentials/reference-updated`, and upstream's web-search card
 * rereads whether its key is configured without a reload.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'
import { keepFailingBrowserState } from './fixtures/browser-failure.mjs'

const KEY_SET = 'A key is configured.'
const KEY_UNSET = /^No key is configured;/u

it('refreshes the web-search card when its key is saved or removed elsewhere', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-credential-refresh-'))
  const config = join(state, 'wrangler.json')
  const mode = process.env.DSH_EDGE_TEST_RUNTIME_MODE ?? 'direct'
  const ownerKey = 'credential-refresh-fixture-owner-key-32'
  let worker, browser
  try {
    await writePrebuiltModeWranglerConfig(mode, config)
    // No deployment key, so the card starts with no key configured.
    worker = await unstable_dev(workerArtifactPath(mode), {
      config, env: mode === 'direct' ? '' : 'isolated', persistTo: state,
      vars: { DSH_EDGE_ACCESS_KEY: ownerKey, DEEPSEEK_API_KEY: '' },
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
    // Without a key the Web client first asks for one; the test saves it elsewhere instead.
    const later = page.getByRole('button', { name: 'Configure later', exact: true })
    await later.click()
    await expect.poll(() => later.count()).toBe(0)

    await page.locator('button[aria-haspopup="dialog"]').last().click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('navigation').getByRole('button', { name: 'Built-in plugins', exact: true }).click()
    await settings.getByRole('tab', { name: 'Settings', exact: true }).click()
    const card = settings.locator('[data-plugin-item="web-search"]')
    await card.getByText(KEY_UNSET).waitFor()

    // The writes go through the API, not the card, as another tab or client would.
    const credentials = (method, payload) => page.evaluate(async ({ method, payload }) => {
      const response = await fetch(`/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
      })
      return (await response.json()).result
    }, { method, payload })
    expect(await credentials('credentials.set', { ref: 'DEEPSEEK_API_KEY', value: 'sk-refresh-fixture-0123456789' }))
      .toMatchObject({ ok: true })
    await card.getByText(KEY_SET, { exact: true }).waitFor()
    expect(await credentials('credentials.unset', { ref: 'DEEPSEEK_API_KEY' })).toMatchObject({ ok: true })
    await card.getByText(KEY_UNSET).waitFor()
  } catch (error) {
    await keepFailingBrowserState('credential-refresh', browser)
    throw error
  } finally {
    await browser?.close()
    await worker?.stop()
    rmSync(state, { recursive: true, force: true })
  }
}, 240_000)
