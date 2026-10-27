/**
 * Real browser check of upstream's changed-files card on the Edge: a turn's
 * file-tool edits appear under the reply with their line counts, and a file's
 * comparison opens in the sidebar.
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

it('shows the changed-files card for a turn\'s file-tool edits', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-workspace-changes-'))
  const config = join(state, 'wrangler.json')
  const mode = process.env.DSH_EDGE_TEST_RUNTIME_MODE ?? 'direct'
  const ownerKey = 'workspace-changes-fixture-owner-key-32'
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
    for (const [path, content] of [['/workspace/changes/kept.txt', 'one\ntwo\nthree\n'], ['/workspace/changes/same.txt', 'same\n']]) {
      expect((await context.request.put(`${origin}/api/workspace/file?path=${path}`, { data: content })).ok()).toBe(true)
    }
    const page = await context.newPage()
    await page.goto(origin)
    const onboarding = page.getByRole('button', { name: 'Continue', exact: true })
    if (await onboarding.waitFor({ timeout: 5000 }).then(() => true, () => false)) await onboarding.click()
    const input = page.getByRole('textbox').last()
    await input.waitFor()
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    // 60 s, as the other browser checks: a slow runner can take long to accept a draft.
    await expect.poll(async () => {
      await input.fill('record workspace changes')
      return await send.isEnabled()
    }, { timeout: 60_000 }).toBe(true)
    await send.click()

    await page.getByText('Edited 2 files', { exact: true }).waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'View changes to changes/kept.txt', exact: true }).click()
    await page.getByText('TWO', { exact: false }).last().waitFor({ timeout: 15_000 })
  } catch (error) {
    await keepFailingBrowserState('workspace-changes', browser)
    throw error
  } finally {
    await browser?.close()
    await worker?.stop()
    await mock.close()
    rmSync(state, { recursive: true, force: true })
  }
}, 240_000)
