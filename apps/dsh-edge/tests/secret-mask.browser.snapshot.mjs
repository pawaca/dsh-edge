/**
 * Real browser check of the two display plugins the Web shell takes from
 * upstream's web-app composition: `client-ui-secret-mask` hides a recognized
 * credential in a sent message, and `client-ui-deepseek-model-label-1017` adds
 * its badge to the model label. Masking is display only: the stored event and
 * the model request keep the text the user sent.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'
import { chatMessages, startMockDeepSeek } from './fixtures/mock-deepseek.mjs'

/** A key-shaped value, long enough for the plugin's recognizer. It is not a credential. */
const FAKE_KEY = 'sk-abcdef0123456789abcdef0123456789'
const PROMPT = `Only reply "ok" please. This is a fake test key ${FAKE_KEY}, ignore it.`

it('masks a pasted credential in the Web display only, and labels the Flash model', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-secret-mask-'))
  const config = join(state, 'wrangler.json')
  const mode = process.env.DSH_EDGE_TEST_RUNTIME_MODE ?? 'direct'
  const ownerKey = 'secret-mask-fixture-owner-key-32-bytes'
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
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    await expect.poll(async () => {
      await input.fill(PROMPT)
      return await send.isEnabled()
    }, { timeout: 30_000 }).toBe(true)
    await send.click()
    await page.getByText('remembered-alpha', { exact: true }).first().waitFor({ timeout: 30_000 })

    // The page never shows the whole key, and shows the start of the masked one.
    const shown = await page.locator('body').innerText()
    expect(shown).not.toContain(FAKE_KEY)
    expect(shown).toMatch(/sk-abcde\*+/u)
    // The model label carries the temporary badge beside the official Flash name.
    const label = page.getByRole('button', { name: /^Select model, current DeepSeek-V4\.1-Flash/u })
    await label.waitFor()
    expect(await label.innerText()).toContain('1017')

    // The stored event and the provider request keep what the user sent.
    const sessions = await (await context.request.get(`${origin}/api/sessions`)).json()
    const [session] = sessions.sessions ?? sessions.items ?? []
    expect(session, 'the browser created one session').toBeDefined()
    const events = (await (await context.request.get(`${origin}/api/sessions/${session.id ?? session.sessionId}/events?after=-1`)).text())
      .split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    const sent = events.find(event => event.type === 'user/message' && event.data.source?.kind !== 'time-context' && JSON.stringify(event.data.content).includes('fake test key'))
    expect(JSON.stringify(sent?.data.content)).toContain(FAKE_KEY)
    expect(mock.requests.some(request => JSON.stringify(chatMessages(request)).includes(FAKE_KEY))).toBe(true)
  } finally {
    await browser?.close()
    await worker?.stop()
    await mock.close()
    rmSync(state, { recursive: true, force: true })
  }
}, 240_000)
