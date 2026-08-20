/** Keyless assembled-runtime snapshot for the model-visible dsh-edge path. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unstable_dev } from 'wrangler'
import {
  workerArtifactPath,
  writePrebuiltModeWranglerConfig,
} from '../scripts/wrangler-config.mjs'
import { startMockDeepSeek } from './fixtures/mock-deepseek.mjs'

const ACCESS_KEY = 'snapshot-owner-access-key-32-bytes'
let ownerCookie

describe('dsh-edge assembled runtime snapshot', () => {
  it('pins the direct bash turn, model requests, event transcript, and cold replay', async () => {
    const persistedState = mkdtempSync(join(tmpdir(), 'dsh-edge-snapshot-'))
    const config = join(persistedState, 'wrangler.json')
    await writePrebuiltModeWranglerConfig('direct', config)
    const mock = await startMockDeepSeek()
    let worker

    try {
      worker = await unstable_dev(workerArtifactPath('direct'), {
        config,
        persistTo: persistedState,
        vars: {
          DEEPSEEK_API_KEY: 'keyless-snapshot-no-call',
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
      ownerCookie = await loginOwner(worker)
      const file = await request(worker, '/api/workspace/file?path=/workspace/session.txt', {
        method: 'PUT',
        body: 'edge-snapshot-tool-value',
      })
      expect(file.status).toBe(200)
      const created = await jsonRequest(worker, '/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Edge snapshot' }),
      })
      expect(created.response.status).toBe(201)
      const sessionId = created.body.session.id

      const response = await request(worker, `/api/sessions/${sessionId}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'run the tool' }),
      })
      expect(response.status).toBe(200)
      const liveEvents = parseEvents(await response.text())
      expect(mock.requests).toHaveLength(2)
      expect(liveEvents.some(event => event.type === 'tool/result')).toBe(true)

      await worker.stop()
      worker = await unstable_dev(workerArtifactPath('direct'), {
        config,
        persistTo: persistedState,
        vars: {
          DEEPSEEK_API_KEY: 'keyless-snapshot-no-call',
          DEEPSEEK_BASE_URL: mock.url,
          DEEPSEEK_SEARCH_BASE_URL: `${mock.url}/anthropic/v1`,
          DSH_EDGE_ACCESS_KEY: ACCESS_KEY,
        },
        logLevel: 'error',
        experimental: {
          disableExperimentalWarning: true,
          showInteractiveDevSession: false,
          watch: false,
        },
      })
      const replay = await request(worker, `/api/sessions/${sessionId}/events?after=-1`)
      expect(replay.status).toBe(200)
      const replayedEvents = parseEvents(await replay.text())

      const normalize = value => JSON.parse(JSON.stringify(value)
        .replaceAll(sessionId, '{{sessionId}}')
        .replaceAll(mock.url, '{{mock-deepseek}}')
        .replace(/"time":\d+/g, '"time":0')
        .replace(/"id":"[0-9a-f-]{36}"/g, '"id":"{{messageId}}"'))
      const snapshot = {
        requests: normalize(mock.requests),
        liveEvents: normalize(liveEvents),
        replayedEvents: normalize(replayedEvents),
      }
      expect(snapshot).toMatchFileSnapshot('./snapshots/edge-turn.expected.txt')

      const searchResponse = await request(worker, `/api/sessions/${sessionId}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'use web search' }),
      })
      expect(searchResponse.status).toBe(200)
      const searchEvents = parseEvents(await searchResponse.text())
      const requestHeader = searchEvents.find(event => event.type === 'request/header')
      const searchCall = searchEvents.find(event => event.type === 'tool/call')
      const providerRequest = searchEvents.find(
        event => event.type === 'web/deepseek-search-llm-request',
      )
      const searchResult = searchEvents.find(event => event.type === 'tool/result')
      const finalMessage = [...searchEvents].reverse()
        .find(event => event.type === 'assistant/message')
      expect(normalize({
        toolNames: requestHeader.data.header.tools.map(tool => tool.name),
        searchGuidance: requestHeader.data.header.system.split('\n\n').at(-1),
        call: searchCall.data,
        providerRequest: providerRequest.data,
        result: {
          content: searchResult.data.message.content,
          meta: searchResult.data.meta,
        },
        finalMessage: finalMessage.data.message.content,
        recordedSearchRequest: mock.searchRequests[0].body,
      })).toMatchFileSnapshot('./snapshots/edge-web-search.expected.txt')
    } finally {
      await worker?.stop()
      await mock.close()
      rmSync(persistedState, { recursive: true, force: true })
    }
  }, 40_000)
})

async function jsonRequest(worker, path, init) {
  const response = await request(worker, path, init)
  return { response, body: await response.json() }
}

function request(worker, path, init) {
  const headers = new Headers(init?.headers)
  headers.set('cookie', ownerCookie)
  return worker.fetch(`http://dsh-edge.test${path}`, { ...init, headers })
}

async function loginOwner(worker) {
  const response = await fetch(`http://${worker.address}:${worker.port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ accessKey: ACCESS_KEY }).toString(),
    redirect: 'manual',
  })
  expect(response.status).toBe(303)
  return response.headers.get('set-cookie').split(';', 1)[0]
}

function parseEvents(source) {
  return source.split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice('data: '.length)))
}
