/** Keyless browser snapshot through the assembled upstream Web application. */

import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { unstable_dev } from 'wrangler'
import {
  workerArtifactPath,
  writePrebuiltModeWranglerConfig,
} from '../scripts/wrangler-config.mjs'
import { startMockDeepSeek } from './fixtures/mock-deepseek.mjs'

const ACCESS_KEY = 'browser-snapshot-owner-key-32-bytes'

describe('dsh-edge assembled browser snapshot', () => {
  it('pins the transcript rendered through the upstream Web client and Edge protocol', async () => {
    const persistedState = mkdtempSync(join(tmpdir(), 'dsh-edge-browser-snapshot-'))
    const config = join(persistedState, 'wrangler.json')
    await writePrebuiltModeWranglerConfig('direct', config, {
      r2BucketName: 'dsh-edge-browser-attachments',
    })
    const mock = await startMockDeepSeek()
    let worker
    let browser

    try {
      worker = await unstable_dev(workerArtifactPath('direct'), {
        config,
        persistTo: persistedState,
        vars: {
          DEEPSEEK_API_KEY: 'keyless-browser-snapshot-no-call',
          DEEPSEEK_BASE_URL: mock.url,
          DSH_EDGE_ACCESS_KEY: ACCESS_KEY,
        },
        logLevel: 'error',
        experimental: {
          disableExperimentalWarning: true,
          showInteractiveDevSession: false,
          watch: false,
        },
      })
      const channel = process.env.DSH_EDGE_PLAYWRIGHT_CHANNEL
      browser = await chromium.launch(channel ? { channel } : undefined)
      const page = await browser.newPage({ locale: 'en-US' })
      const pageErrors = []
      page.on('pageerror', error => { pageErrors.push(error.message) })
      const origin = `http://${worker.address}:${String(worker.port)}`
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text) => { globalThis.__dshEdgeCopiedText = text },
          },
        })
      })
      await page.route('https://registry.npmjs.org/dsh-edge/latest', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ version: '0.6.0' }),
      }))
      await page.route('https://registry.npmjs.org/dsh-edge/next', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ version: '0.6.0' }),
      }))
      await page.goto(origin, { waitUntil: 'load' })
      await page.getByLabel('Owner access key').fill(ACCESS_KEY)
      await page.getByRole('button', { name: 'Unlock', exact: true }).click()
      await page.waitForURL(`${origin}/`)
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      const ownerCookie = (await page.context().cookies())
        .find(cookie => cookie.name === 'dsh_edge_owner')
      expect(ownerCookie).toBeDefined()
      const ownerCookieHeader = `${ownerCookie.name}=${ownerCookie.value}`

      const continueButton = page.getByRole('button', { name: 'Continue', exact: true })
      if (await continueButton.count() > 0
        || await continueButton.waitFor({ timeout: 5_000 }).then(() => true, () => false)) {
        await continueButton.click()
        await expect.poll(() => continueButton.count(), { timeout: 5_000 }).toBe(0)
      }

      await page.locator('button[aria-haspopup="dialog"]').last().click()
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.getByRole('navigation')
        .getByRole('button', { name: 'DSH Edge', exact: true })
        .click()
      await expect.poll(() => settings.getByText('0.5.1-alpha.1', { exact: true }).count()).toBe(1)
      await settings.getByRole('button', { name: 'Copy upgrade command', exact: true }).click()
      await expect.poll(() => settings.getByRole('button', {
        name: 'Upgrade command copied', exact: true,
      }).count())
        .toBe(1)
      expect(await page.evaluate(() => globalThis.__dshEdgeCopiedText))
        .toBe('npx dsh-edge@latest upgrade')
      const edgeSettingsSnapshot = await stableAria(page, '[role="dialog"]')
      await expect(normalize(edgeSettingsSnapshot))
        .toMatchFileSnapshot('./snapshots/edge-settings.expected.md')
      await settings.getByRole('button', { name: 'Agent presets', exact: true }).click()
      const presetReadResponse = page.waitForResponse(response =>
        rpcResponseIs(response, 'agentPreset.read'))
      await settings.getByRole('button', { name: 'View: DSH Edge', exact: true }).click()
      const presetWire = await (await presetReadResponse).json()
      expect(presetWire.result.ok).toBe(true)
      expect(presetWire.result.value.content).not.toContain(ACCESS_KEY)
      const presetViewer = page.getByRole('dialog', { name: 'View · DSH Edge', exact: true })
      await presetViewer.waitFor()
      await expect.poll(
        () => settings.getByText('This capability is not available in the Edge runtime.').count(),
      ).toBe(0)
      const presetSnapshot = await stableAria(page, '[role="dialog"][aria-label="View · DSH Edge"]')
      await expect(normalize(presetSnapshot))
        .toMatchFileSnapshot('./snapshots/edge-agent-preset.expected.md')
      await presetViewer.getByRole('button', { name: 'Close', exact: true }).last().click()
      await settings.getByRole('button', { name: 'Close', exact: true }).click()

      const workspaceRenameResponse = page.waitForResponse(response =>
        rpcResponseIs(response, 'workspace.rename'))
      await page.getByRole('treeitem', { name: 'Workspace', exact: true }).hover()
      await page.getByRole('button', { name: 'Workspace actions for Workspace' }).click()
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
      const workspaceName = page.getByRole('textbox', { name: 'Workspace name' })
      await workspaceName.fill('Edge browser')
      await page.getByRole('button', { name: 'Rename', exact: true }).click()
      const workspaceRenameWire = await (await workspaceRenameResponse).json()
      expect(workspaceRenameWire.result.ok).toBe(true)
      await expect.poll(
        () => page.getByRole('treeitem', { name: 'Edge browser', exact: true }).count(),
        { timeout: 15_000 },
      ).toBe(1)

      const initialSessions = await edgeRpc(worker, ownerCookieHeader, 'session.list', {})
      const initialSessionId = initialSessions.result.value.items
        .find(item => item.blank === true)?.sessionId
      expect(initialSessionId).toBeTypeOf('string')
      const selectVision = await edgeRpc(worker, ownerCookieHeader, 'session.selectModel', {
        sessionId: initialSessionId,
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash-vision-exp',
      })
      expect(selectVision.result.ok).toBe(true)

      const composer = page.locator('textarea:enabled').last()
      await composer.waitFor({ timeout: 15_000 })
      await composer.evaluate((textarea) => {
        const png = Uint8Array.from(
          atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4XmP4z8DwHwAFAAH/NQZ7kgAAAABJRU5ErkJggg=='),
          character => character.charCodeAt(0),
        )
        const transfer = new DataTransfer()
        transfer.items.add(new File([png], 'one-pixel.png', {
          type: 'image/png',
        }))
        textarea.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        }))
      })
      await expect.poll(
        () => page.getByRole('group', { name: 'Pending images' }).count(),
      ).toBe(1)
      await composer.fill('snapshot the browser edge path')
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect.poll(
        () => page.getByText('remembered-alpha', { exact: true }).count(),
        { timeout: 30_000 },
      ).toBeGreaterThanOrEqual(1)
      await expect.poll(() => composer.isEnabled(), { timeout: 15_000 }).toBe(true)

      // The client only increments a fork title when the source already has a
      // durable title projection. Seed that upstream state through the same
      // RPC carrier, then wait until the browser mirror has consumed its push.
      const listed = await edgeRpc(worker, ownerCookieHeader, 'session.list', {})
      const sourceId = listed.result.value.items.find(item => item.blank === false)?.sessionId
      expect(sourceId).toBeTypeOf('string')
      const sourceTitle = 'Browser snapshot'
      const sourceRename = await edgeRpc(worker, ownerCookieHeader, 'session.rename', {
        sessionId: sourceId,
        title: sourceTitle,
      })
      expect(sourceRename.result.ok).toBe(true)
      await expect.poll(
        () => page.getByText(sourceTitle, { exact: true }).count(),
        { timeout: 15_000 },
      ).toBeGreaterThanOrEqual(1)

      const searchButton = page.getByRole('button', { name: 'Search sessions' })
      if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
      const search = page.getByRole('textbox', { name: 'Search sessions...', exact: true })
      const searchResponse = page.waitForResponse(response => rpcResponseIs(response, 'session.search'))
      await search.fill('remembered-alpha')
      const searchWire = await (await searchResponse).json()
      expect(searchWire.result.ok).toBe(true)
      expect(searchWire.result.value.items).toContainEqual(expect.objectContaining({ sessionId: sourceId }))
      const searchResults = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
      await expect.poll(() => searchResults.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
      await expect.poll(
        () => page.getByText(/session search is unavailable/iu).count(),
      ).toBe(0)
      await search.fill('')
      await searchButton.click()

      const rpcRequests = []
      page.on('request', (request) => {
        if (request.method() !== 'POST') return
        try {
          const body = request.postDataJSON()
          if (typeof body?.method === 'string') rpcRequests.push(body)
        } catch {
          // Non-JSON browser requests do not use the upstream RPC carrier.
        }
      })
      const forkResponse = page.waitForResponse(response => rpcResponseIs(response, 'session.fork'))
      const renameResponse = page.waitForResponse(response => rpcResponseIs(response, 'session.rename'))
      await page.getByRole('button', { name: 'Branch into a new conversation' }).click()
      const forkWire = await (await forkResponse).json()
      expect(forkWire.result.ok).toBe(true)
      const childId = forkWire.result.value.sessionId
      const renameWire = await (await renameResponse).json()
      expect(renameWire.result.ok).toBe(true)
      await expect.poll(() => rpcRequests.some(request => request.method === 'session.history'
        && request.payload?.sessionId === childId), { timeout: 15_000 }).toBe(true)
      await expect.poll(
        () => page.getByText('Browser snapshot (1)', { exact: true }).count(),
        { timeout: 15_000 },
      ).toBeGreaterThanOrEqual(1)
      await expect.poll(
        () => page.getByText('remembered-alpha', { exact: true }).count(),
        { timeout: 15_000 },
      ).toBeGreaterThanOrEqual(1)
      await page.mouse.move(0, 0)
      await expect.poll(() => page.getByRole('tooltip').count()).toBe(0)
      await expect.poll(
        () => page.getByRole('button', {
          name: 'Select model, current DeepSeek-V4-Flash-Vision-Exp, reasoning effort High',
          exact: true,
        }).count(),
        { timeout: 15_000 },
      ).toBe(1)
      await expect.poll(
        () => page.getByRole('button', {
          name: 'one-pixel.png, click to view original',
          exact: true,
        }).getByRole('img', { name: 'one-pixel.png', exact: true }).count(),
        { timeout: 15_000 },
      ).toBeGreaterThanOrEqual(1)

      const transcript = await stableAria(page, '[class*="centerCol"]')
      await expect(normalize(transcript))
        .toMatchFileSnapshot('./snapshots/edge-browser.expected.md')

      const archiveResponse = page.waitForResponse(response =>
        rpcResponseIs(response, 'workspace.archiveSession'))
      await page.getByRole('treeitem', {
        name: /Browser snapshot \(1\)/u,
      }).hover()
      await page.getByRole('button', {
        name: 'Session actions for Browser snapshot (1)',
      }).click()
      await page.getByRole('menuitem', { name: 'Archive session' }).click()
      const archiveWire = await (await archiveResponse).json()
      expect(archiveWire.result.ok).toBe(true)
      expect(archiveWire.result.value.archivedSessionIds).toContain(childId)
      await expect.poll(
        () => page.getByText('Browser snapshot (1)', { exact: true }).count(),
        { timeout: 15_000 },
      ).toBe(0)
      await expect.poll(
        () => page.getByText(sourceTitle, { exact: true }).count(),
        { timeout: 15_000 },
      ).toBeGreaterThanOrEqual(1)
      const archivedTree = await stableAria(page, '[role="tree"][aria-label="Sessions"]')
      await expect(normalize(archivedTree))
        .toMatchFileSnapshot('./snapshots/edge-browser-archived.expected.md')
      expect(pageErrors).toEqual([])
      expect(mock.requests).toHaveLength(1)

      await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
      const nowSeconds = Math.floor(Date.now() / 1_000)
      const signedExpiresAt = nowSeconds - 1
      await page.context().addCookies([{
        name: 'dsh_edge_owner',
        value: createOwnerSessionValue(signedExpiresAt),
        url: origin,
        // Keep the cookie in the browser so the Worker, rather than browser
        // expiry timing, deterministically rejects its expired signed claim.
        expires: nowSeconds + 60,
        httpOnly: true,
        sameSite: 'Strict',
      }])
      await page.evaluate(() => {
        void window.fetch('/api/workspace/file?path=/workspace/owner-session-expiry-probe')
      })
      await page.waitForURL(`${origin}/login`, { timeout: 20_000 })
      await expect.poll(
        () => page.getByRole('heading', { name: 'Unlock this deployment' }).count(),
        { timeout: 15_000 },
      ).toBe(1)
      expect(pageErrors).toEqual([])
    } finally {
      await browser?.close()
      await worker?.stop()
      await mock.close()
      rmSync(persistedState, { recursive: true, force: true })
    }
  }, 60_000)

  it('enables upstream image intake through the temporary DO attachment backend', async () => {
    const persistedState = mkdtempSync(join(tmpdir(), 'dsh-edge-browser-temporary-'))
    const config = join(persistedState, 'wrangler.json')
    await writePrebuiltModeWranglerConfig('direct', config)
    let worker
    let browser

    try {
      worker = await unstable_dev(workerArtifactPath('direct'), {
        config,
        persistTo: persistedState,
        vars: {
          DEEPSEEK_API_KEY: 'keyless-browser-temporary-no-call',
          DSH_EDGE_ACCESS_KEY: ACCESS_KEY,
        },
        logLevel: 'error',
        experimental: {
          disableExperimentalWarning: true,
          showInteractiveDevSession: false,
          watch: false,
        },
      })
      const channel = process.env.DSH_EDGE_PLAYWRIGHT_CHANNEL
      browser = await chromium.launch(channel ? { channel } : undefined)
      const page = await browser.newPage({ locale: 'en-US' })
      const origin = `http://${worker.address}:${String(worker.port)}`
      await page.goto(origin, { waitUntil: 'load' })
      await page.getByLabel('Owner access key').fill(ACCESS_KEY)
      await page.getByRole('button', { name: 'Unlock', exact: true }).click()
      await page.waitForURL(`${origin}/`)
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      const ownerCookie = (await page.context().cookies())
        .find(cookie => cookie.name === 'dsh_edge_owner')
      expect(ownerCookie).toBeDefined()
      const ownerCookieHeader = `${ownerCookie.name}=${ownerCookie.value}`
      const sessions = await edgeRpc(worker, ownerCookieHeader, 'session.list', {})
      expect(sessions.result.ok).toBe(true)
      expect(sessions.result.value.items[0].projections.values.imageLimits).toMatchObject({
        maxImagesPerMessage: 4,
        mediaTypes: ['image/png', 'image/jpeg'],
      })

      const composer = page.locator('textarea:enabled').last()
      await composer.waitFor({ timeout: 15_000 })
      await composer.evaluate((textarea) => {
        const png = Uint8Array.from(
          atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4XmP4z8DwHwAFAAH/NQZ7kgAAAABJRU5ErkJggg=='),
          character => character.charCodeAt(0),
        )
        const transfer = new DataTransfer()
        transfer.items.add(new File([png], 'one-pixel.png', { type: 'image/png' }))
        textarea.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        }))
      })
      await expect.poll(
        () => page.getByRole('group', { name: 'Pending images' }).count(),
        { timeout: 15_000 },
      ).toBe(1)
    } finally {
      await browser?.close()
      await worker?.stop()
      rmSync(persistedState, { recursive: true, force: true })
    }
  }, 60_000)
})

async function stableAria(page, selector) {
  const region = page.locator(selector).first()
  let previous = await region.ariaSnapshot()
  await expect.poll(async () => {
    const current = await region.ariaSnapshot()
    const stable = current === previous
    previous = current
    return stable
  }, { timeout: 5_000 }).toBe(true)
  return previous
}

function rpcResponseIs(response, method) {
  if (response.request().method() !== 'POST') return false
  try {
    return response.request().postDataJSON()?.method === method
  } catch {
    return false
  }
}

async function edgeRpc(worker, ownerCookie, method, payload) {
  const rpcId = crypto.randomUUID()
  const response = await worker.fetch(`http://dsh-edge.test/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const wire = await response.json()
  expect(wire.rpcId).toBe(rpcId)
  return wire
}

function normalize(source) {
  return `${source
    .replace(/http:\/\/127\.0\.0\.1:\d+/gu, '{{mock-deepseek}}')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\b/giu, '{{clock}}')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|tok\/s)\b/giu, '{{metric}}')
    .trimEnd()}\n`
}

function createOwnerSessionValue(expiresAt) {
  const signature = createHmac('sha256', ACCESS_KEY)
    .update(`dsh-edge-owner-session\0${String(expiresAt)}`)
    .digest('base64url')
  return `v1.${String(expiresAt)}.${signature}`
}
