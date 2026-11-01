/** Exercise the public owner gate and the published mobile plugin on real artifacts. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { unstable_dev } from 'wrangler'
import { workerArtifactPath, writePrebuiltModeWranglerConfig } from '../scripts/wrangler-config.mjs'
import { startMockDeepSeek } from './fixtures/mock-deepseek.mjs'
import { keepFailingBrowserState } from './fixtures/browser-failure.mjs'

const ACCESS_KEY = 'owner-ui-browser-test-key-32-bytes'

it('keeps the official welcome presentation usable on phones and reuses the mobile shell', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-owner-ui-'))
  const mode = process.env.DSH_EDGE_TEST_RUNTIME_MODE ?? 'direct'
  const config = join(state, 'wrangler.json')
  await writePrebuiltModeWranglerConfig(mode, config)
  const mock = await startMockDeepSeek()
  let worker
  let browser
  try {
    worker = await unstable_dev(workerArtifactPath(mode), {
      config, persistTo: state,
      vars: { DEEPSEEK_API_KEY: 'keyless-no-call', DEEPSEEK_BASE_URL: mock.url, DSH_EDGE_ACCESS_KEY: ACCESS_KEY },
      logLevel: 'error',
      experimental: { disableExperimentalWarning: true, showInteractiveDevSession: false, watch: false },
    })
    const channel = process.env.DSH_EDGE_PLAYWRIGHT_CHANNEL
    browser = await chromium.launch(channel ? { channel } : undefined)
    const origin = `http://${worker.address}:${String(worker.port)}`
    const errors = []
    for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      const context = await browser.newContext({ viewport: size, locale: 'zh-CN' })
      const page = await context.newPage()
      page.on('pageerror', error => { errors.push(error.message) })
      await page.goto(`${origin}/login`)
      await page.locator('.brand').evaluate(image => image.decode())
      await page.evaluate(() => document.fonts.ready)
      expect(await page.locator('input').count()).toBe(0)
      await screenshot(page, `welcome-${size.width}`)
      await page.getByRole('link', { name: '登录', exact: true }).click()
      const key = page.getByLabel('访问密钥', { exact: true })
      await key.fill('incorrect-key')
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await page.getByRole('alert').waitFor()
      expect(await key.inputValue()).toBe('')
      await key.fill(ACCESS_KEY)
      await screenshot(page, `key-${size.width}`)
      await assertWithinViewport(page.locator('.key-form'), size.width)
      await assertWithinViewport(page.getByRole('button', { name: '登录', exact: true }), size.width)
      // A short viewport covers landscape and the on-screen-keyboard case: the
      // form must remain scrollable, with a reachable submit action.
      if (size.width === 320) {
        await page.setViewportSize({ width: 320, height: 300 })
        await page.getByRole('button', { name: '登录', exact: true }).scrollIntoViewIfNeeded()
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
        await page.setViewportSize(size)
      }
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await page.waitForURL(`${origin}/`)
      await page.locator('[class*="_frame"]').first().waitFor()
      const continueButton = page.getByRole('button', { name: '继续', exact: true })
      if (await continueButton.waitFor({ timeout: 5000 }).then(() => true, () => false)) await continueButton.click()
      if (size.width === 390) {
        await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dsh-mobile-shell'))).toBe(true)
        await screenshot(page, 'mobile-chat')
        // The exact npm bundle is served; there is no Edge fork of its UI.
        const bundled = await (await page.request.get(`${origin}/plugins/dsh-webui-mobile/client.js`)).text()
        expect(bundled).toBe(readFileSync(new URL('../standalone/node_modules/dsh-webui-mobile/src/client.js', import.meta.url), 'utf8'))
        await assertWithinViewport(page.locator('.pI_x6G_centerCol'), size.width)
        await page.getByRole('button', { name: '打开菜单', exact: true }).click()
        await page.locator('button[aria-haspopup="dialog"]').last().click()
        const settings = page.getByRole('dialog')
        await settings.waitFor()
        await assertWithinViewport(settings, size.width)
        await settings.evaluate(async element => {
          await Promise.all(element.getAnimations({ subtree: true }).filter(animation =>
            animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
        })
        expect(await settings.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
        await screenshot(page, 'mobile-settings')
        await settings.getByRole('navigation').getByRole('button', { name: 'MCP 连接器', exact: true }).click()
        const addServer = settings.getByRole('button', { name: /添加连接器/u })
        await addServer.waitFor()
        await assertWithinViewport(addServer, size.width)
        await addServer.click()
        await assertWithinViewport(settings.getByPlaceholder('服务器名称（如 github）'), size.width)
        await screenshot(page, 'mobile-mcp')
        await page.setViewportSize({ width: 1280, height: 800 })
        await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dsh-mobile-shell'))).toBe(false)
      }
      await context.close()
    }
    expect(errors).toEqual([])
  } catch (error) {
    await keepFailingBrowserState('owner-ui', browser)
    throw error
  } finally {
    await browser?.close()
    await worker?.stop()
    await mock.close()
    rmSync(state, { recursive: true, force: true })
  }
})

async function assertWithinViewport(locator, width) {
  await expect.poll(async () => {
    const box = await locator.boundingBox()
    return box !== null && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1
  }).toBe(true)
}

async function screenshot(page, name) {
  const dir = process.env.DSH_EDGE_BROWSER_ARTIFACTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true, animations: 'disabled' })
}
