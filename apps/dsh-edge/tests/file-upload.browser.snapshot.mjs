/**
 * Real browser check of upstream file uploads on the Edge: a text file and a
 * PDF chosen in the Web composer stream to /api/session/uploadFileBinary, the
 * prompt carries their receipts, and the model reads the saved copy by the
 * path its file handle names.
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

const NOTES = 'browser upload notes: delta epsilon\n'
// A minimal one-page PDF; the Edge stores any bytes verbatim.
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'

it('uploads non-image files from the composer and lets the model read them', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-file-upload-'))
  const config = join(state, 'wrangler.json')
  const mode = process.env.DSH_EDGE_TEST_RUNTIME_MODE ?? 'direct'
  const ownerKey = 'file-upload-fixture-owner-key-32-chars'
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
    const uploads = []
    page.on('response', response => {
      if (response.url().includes('/api/session/uploadFileBinary') && response.ok()) uploads.push(new URL(response.url()).searchParams.get('name'))
    })
    await page.goto(origin)
    const onboarding = page.getByRole('button', { name: 'Continue', exact: true })
    if (await onboarding.waitFor({ timeout: 5000 }).then(() => true, () => false)) await onboarding.click()
    const input = page.getByRole('textbox').last()
    await input.waitFor()
    await page.locator('input[type="file"]').first().setInputFiles([
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(NOTES) },
      { name: 'brief.pdf', mimeType: 'application/pdf', buffer: Buffer.from(PDF) },
    ])
    // Send only once both files have uploaded and show as cards; a slow
    // runner could otherwise send the text before the receipts exist.
    await expect.poll(() => uploads.length, { timeout: 60_000 }).toBe(2)
    await page.getByText('notes.txt', { exact: true }).first().waitFor()
    await page.getByText('brief.pdf', { exact: true }).first().waitFor()
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    // 60 s: Windows release runs have stalled past 30 s before the Web client accepts a draft
    // (0.27.1 release run 39555631013); a failure keeps the page state for diagnosis.
    await expect.poll(async () => {
      await input.fill('read the uploaded file')
      return await send.isEnabled()
    }, { timeout: 60_000 }).toBe(true)
    await send.click()

    await page.getByText(/uploaded-read:[\s\S]*browser upload notes: delta epsilon/u).first().waitFor({ timeout: 60_000 })
    expect(uploads.sort((a, b) => a.localeCompare(b))).toEqual(['brief.pdf', 'notes.txt'])
  } catch (error) {
    await keepFailingBrowserState('file-upload', browser)
    throw error
  } finally {
    await browser?.close()
    await worker?.stop()
    await mock.close()
    rmSync(state, { recursive: true, force: true })
  }
}, 240_000)
