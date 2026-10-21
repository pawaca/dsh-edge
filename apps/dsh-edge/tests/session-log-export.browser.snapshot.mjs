/**
 * Real browser check of the session log download the Web shell takes from
 * upstream's `dsh-session-log-export`: the session header's "Download session
 * log" item and the `/export` command both hand the browser a ZIP that the
 * Edge's paged exporter streams, holding the session's log.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'
import { keepFailingBrowserState } from './fixtures/browser-failure.mjs'
import { startMockDeepSeek } from './fixtures/mock-deepseek.mjs'

const { unzipSync, strFromU8 } = createRequire(import.meta.resolve('@deepseek-ai/dsh-session-log-export'))('fflate')
const PROMPT = 'Only reply ok please, this session is exported.'

it('downloads the session log from the header menu and from /export', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-session-log-export-'))
  const config = join(state, 'wrangler.json')
  const mode = process.env.DSH_EDGE_TEST_RUNTIME_MODE ?? 'direct'
  const ownerKey = 'session-log-export-fixture-owner-key-32'
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
    const context = await browser.newContext({ acceptDownloads: true })
    const origin = `http://${worker.address}:${worker.port}`
    expect((await context.request.post(`${origin}/api/auth/login`, { form: { accessKey: ownerKey } })).ok()).toBe(true)
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
      await input.fill(PROMPT)
      return await send.isEnabled()
    }, { timeout: 60_000 }).toBe(true)
    await send.click()
    await page.getByText('remembered-alpha', { exact: true }).first().waitFor({ timeout: 30_000 })

    // The header's more-actions menu offers the download.
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    const fromMenu = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'Download session log' }).click()
    const menuArchive = await archiveOf(await fromMenu, state, 'menu.zip')
    expect(menuArchive.name).toMatch(/^dsh-session-.+\.zip$/u)
    expect(menuArchive.log).toContain(PROMPT)

    // So does /export, which also logs the command that started it.
    const fromCommand = page.waitForEvent('download')
    await expect.poll(async () => {
      await input.fill('/export')
      return await send.isEnabled()
    }, { timeout: 30_000 }).toBe(true)
    await input.press('Enter')
    const commandArchive = await archiveOf(await fromCommand, state, 'command.zip')
    expect(commandArchive.log).toContain(PROMPT)
    expect(commandArchive.log).toContain('command/run')
  } catch (error) {
    await keepFailingBrowserState('session-log-export', browser)
    throw error
  } finally {
    await browser?.close()
    await worker?.stop()
    await mock.close()
    rmSync(state, { recursive: true, force: true })
  }
}, 240_000)

/** Save a browser download and read the root session log out of the ZIP. */
async function archiveOf(download, dir, file) {
  const path = join(dir, file)
  await download.saveAs(path)
  const entries = unzipSync(new Uint8Array(readFileSync(path)))
  const root = Object.keys(entries).find(name => /^session(?:\.v\d+)?\.jsonl$/u.test(name))
  expect(root, `root log among ${Object.keys(entries).join(', ')}`).toBeDefined()
  return { name: download.suggestedFilename(), log: strFromU8(entries[root]) }
}
