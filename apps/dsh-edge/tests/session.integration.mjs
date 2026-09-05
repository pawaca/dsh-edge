import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unstable_dev } from 'wrangler'
import WebSocket from 'ws'
import {
  workerArtifactPath,
  writePrebuiltModeWranglerConfig,
} from '../scripts/wrangler-config.mjs'
import { startMockDeepSeek } from './fixtures/mock-deepseek.mjs'

const ACCESS_KEY = 'integration-owner-access-key-32-bytes'
const RELEASED_SESSION_ID = 'session-v0-1-3'
const RELEASED_ARCHIVED_SESSION_ID = 'session-v0-1-3-blank'
const persistedState = mkdtempSync(join(tmpdir(), 'dsh-edge-integration-'))
const runtimeMode = process.env.DSH_EDGE_TEST_RUNTIME_MODE ?? 'direct'
assert.ok(runtimeMode === 'direct' || runtimeMode === 'isolated', 'invalid test runtime mode')
const attachmentBackend = process.env.DSH_EDGE_TEST_ATTACHMENT_BACKEND ?? 'private-r2'
assert.ok(
  attachmentBackend === 'private-r2' || attachmentBackend === 'temporary-do',
  'invalid test attachment backend',
)
const runtimeConfig = join(persistedState, `wrangler-${runtimeMode}.json`)
await writePrebuiltModeWranglerConfig(runtimeMode, runtimeConfig,
  attachmentBackend === 'private-r2'
    ? { r2BucketName: 'dsh-edge-integration-attachments' }
    : {})
const mock = await startMockDeepSeek()
let worker
let releasedStateSeeder
let ownerCookie

try {
  releasedStateSeeder = await startReleasedStateSeeder()
  await seedReleasedState()
  await releasedStateSeeder.stop()
  releasedStateSeeder = undefined

  worker = await startWorker()
  const lockedShell = await fetch(`http://${worker.address}:${worker.port}/`, {
    redirect: 'manual',
  })
  assert.equal(lockedShell.status, 302)
  assert.equal(lockedShell.headers.get('location'), '/login')
  const lockedApi = await worker.fetch('http://dsh-edge.test/api/sessions')
  assert.equal(lockedApi.status, 401)
  assert.equal(lockedApi.headers.get('www-authenticate'), 'DshEdgeOwner')
  assert.equal(await rejectedDownlinkStatus('/api/events.mux'), 401)

  const invalidLogin = await loginOwner('invalid-owner-access-key-32-bytes')
  assert.equal(invalidLogin.status, 401)
  assert.equal(invalidLogin.headers.has('set-cookie'), false)
  const login = await loginOwner(ACCESS_KEY)
  assert.equal(login.status, 303)
  ownerCookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  assert.match(ownerCookie ?? '', /^dsh_edge_owner=v1\./u)
  assert.equal(await rejectedDownlinkStatus('/api/events.mux', {
    cookie: ownerCookie,
    origin: 'http://untrusted.dsh-edge.test',
  }), 403)

  const releasedFile = await request('/api/workspace/file?path=/workspace/released.txt')
  assert.equal(releasedFile.status, 200)
  assert.equal(await releasedFile.text(), 'dsh-edge-0.1.3-vfs')

  const releasedSession = await jsonRequest(`/api/sessions/${RELEASED_SESSION_ID}`)
  assert.equal(releasedSession.response.status, 200)
  assert.equal(releasedSession.body.session.title, 'DSH Edge 0.1.3 fixture')
  const releasedHistory = await request(`/api/sessions/${RELEASED_SESSION_ID}/events`)
  assert.equal(releasedHistory.status, 200)
  const releasedEvents = parseEvents(await releasedHistory.text())
  assert.equal(releasedEvents.at(-1).type, 'turn/end')
  assert.equal(releasedEvents.at(-1).seq, 6)
  const releasedContinuation = await turn(RELEASED_SESSION_ID, 'continue released fixture')
  assert.equal(assistantText(releasedContinuation), 'released-history-ok')
  const releasedHistoryCheck = await turn(RELEASED_SESSION_ID, 'released history after upgrade')
  assert.equal(assistantText(releasedHistoryCheck), 'released-history-ok')

  const releasedBlankList = await rpc('session.list', {})
  const releasedBlankSummary = releasedBlankList.body.result.value.items
    .find(item => item.sessionId === RELEASED_ARCHIVED_SESSION_ID)
  assert.equal(releasedBlankSummary.blank, true)
  assert.equal(releasedBlankSummary.projections.asOfSeq, -1)
  const releasedBlank = await jsonRequest(`/api/sessions/${RELEASED_ARCHIVED_SESSION_ID}`)
  assert.equal(releasedBlank.response.status, 200)
  assert.equal(releasedBlank.body.session.title, null)
  const releasedBlankContinuation = await turn(
    RELEASED_ARCHIVED_SESSION_ID,
    'continue released blank',
  )
  assert.equal(assistantText(releasedBlankContinuation), 'remembered-alpha')

  const releasedWorkspace = await rpc('workspace.list', {})
  assert.equal(releasedWorkspace.body.result.ok, true)
  assert.equal(
    releasedWorkspace.body.result.value.items[0].title,
    'DSH Edge 0.1.3 workspace',
  )
  assert.deepEqual(releasedWorkspace.body.result.value.items[0].sessionIds, [
    RELEASED_ARCHIVED_SESSION_ID,
    RELEASED_SESSION_ID,
  ])
  assert.deepEqual(releasedWorkspace.body.result.value.archivedSessionIds, [
    RELEASED_ARCHIVED_SESSION_ID,
  ])
  // Epoch-0 createdAt from fixture must be repaired during migration
  const migratedWorkspace = releasedWorkspace.body.result.value.items[0]
  assert.notEqual(migratedWorkspace.createdAt, '1970-01-01T00:00:00.000Z',
    'epoch-0 createdAt should be repaired')
  assert.ok(migratedWorkspace.createdAt <= migratedWorkspace.updatedAt,
    'repaired createdAt must not be later than updatedAt')
  const upgradedReleasedWorkspace = await rpc('workspace.rename', {
    workspaceId: 'edge-workspace',
    title: 'Upgraded 0.1.3 workspace',
  })
  assert.equal(upgradedReleasedWorkspace.body.result.ok, true)
  assert.equal(
    upgradedReleasedWorkspace.body.result.value.workspace.title,
    'Upgraded 0.1.3 workspace',
  )

  const upgradedFile = await request('/api/workspace/file?path=/workspace/after-upgrade.txt', {
    method: 'PUT',
    body: 'current-runtime-write',
  })
  assert.equal(upgradedFile.status, 200)
  const crossOriginMutation = await request('/api/sessions/not-real/cancel', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://untrusted.dsh-edge.test',
    },
    body: '',
  })
  assert.equal(crossOriginMutation.status, 403)
  assert.deepEqual(await crossOriginMutation.json(), {
    ok: false,
    error: 'Cross-origin authenticated requests are not allowed.',
  })

  const shell = await assetRequest('/')
  assert.equal(shell.status, 200)
  assert.equal(shell.headers.get('x-frame-options'), 'DENY')
  assert.match(shell.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/u)
  const shellHtml = await shell.text()
  assert.match(shellHtml, /globalThis\["__DSH_BOOT__"\]/u)
  assert.match(shellHtml, /@deepseek-ai\/dsh-client-connection/u)
  assert.match(
    shellHtml,
    /response\.headers\.get\('www-authenticate'\) === 'DshEdgeOwner'/u,
  )
  for (const alias of ['/index.html', '/sessions/spa-fallback']) {
    const aliasShell = await assetRequest(alias)
    assert.equal(aliasShell.status, 200)
    assert.equal(aliasShell.headers.get('x-frame-options'), 'DENY')
    assert.match(aliasShell.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/u)
    assert.match(await aliasShell.text(), /globalThis\["__DSH_BOOT__"\]/u)
  }
  const connectionBundle = await assetRequest(
    '/plugins/@deepseek-ai/dsh-client-connection/client.js',
  )
  assert.equal(connectionBundle.status, 200)
  assert.match(connectionBundle.headers.get('content-type') ?? '', /javascript/u)

  const titleless = await jsonRequest('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(titleless.response.status, 400)
  assert.equal(titleless.body.error, 'title must be a non-empty string.')

  const invisibleTitle = await jsonRequest('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '\u200b' }),
  })
  assert.equal(invisibleTitle.response.status, 400)
  assert.equal(invisibleTitle.body.error, 'Session title must contain visible text.')

  const oversizedSessionBody = await jsonRequest('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x'.repeat(600_000) }),
  })
  assert.equal(oversizedSessionBody.response.status, 413)

  // A prompt on the Typert route carries inline image data and long text, so
  // the entry Worker must give it the turn budget rather than the 8 KiB
  // session-create default; the request reaches the instance and fails on the
  // unknown session inside the RPC envelope instead of a transport 413.
  const largeTypertPrompt = await typertRpc('session', 'prompt', {
    request: {
      sessionId: 'not-real',
      mode: 'queue',
      content: [{ type: 'text', text: 'x'.repeat(64_000) }],
    },
  })
  assert.equal(largeTypertPrompt.response.status, 200)
  assert.equal(largeTypertPrompt.body.type, 'server-response')
  assert.equal(largeTypertPrompt.body.result.ok, false)

  const malformedSessionId = await jsonRequest('/api/sessions/%/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'must not run' }),
  })
  assert.equal(malformedSessionId.response.status, 400)
  assert.equal(malformedSessionId.body.error, 'Invalid session id.')

  const overflowingReplay = await jsonRequest(
    '/api/sessions/not-materialized/events?after=9007199254740991',
  )
  assert.equal(overflowingReplay.response.status, 400)
  assert.equal(overflowingReplay.body.error, 'after exceeds the supported integer range.')

  const malformedUtf8 = await jsonRequest(
    '/api/workspace/file?path=/workspace/malformed.txt',
    { method: 'PUT', body: new Uint8Array([0xff]) },
  )
  assert.equal(malformedUtf8.response.status, 400)
  assert.equal(malformedUtf8.body.error, 'The request body must contain valid UTF-8.')

  const oversizedUtf8 = await jsonRequest(
    '/api/workspace/file?path=/workspace/oversized.txt',
    { method: 'PUT', body: '界'.repeat(400_000) },
  )
  assert.equal(oversizedUtf8.response.status, 413)

  const oversizedCommand = await jsonRequest('/api/workspace/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: '界'.repeat(16_384) }),
  })
  assert.equal(oversizedCommand.response.status, 413)

  const firstFreshShell = await jsonRequest('/api/workspace/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      command: 'printf fresh-shell-ok > /workspace/first.txt && cat /workspace/first.txt',
    }),
  })
  assert.equal(firstFreshShell.response.status, 200)
  assert.equal(firstFreshShell.body.status, 'completed')
  assert.equal(firstFreshShell.body.stdout, 'fresh-shell-ok')

  const disabledNetwork = await jsonRequest('/api/workspace/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'curl https://example.com' }),
  })
  assert.equal(disabledNetwork.response.status, 200)
  assert.notEqual(disabledNetwork.body.exitCode, 0)
  if (runtimeMode === 'direct') {
    assert.equal(disabledNetwork.body.exitCode, 127)
    assert.match(disabledNetwork.body.stderr, /curl: command not found/u)
  }

  const conventionalSignalExit = await jsonRequest('/api/workspace/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'exit 130' }),
  })
  assert.equal(conventionalSignalExit.response.status, 200)
  assert.equal(conventionalSignalExit.body.exitCode, 130)
  assert.equal(conventionalSignalExit.body.status, 'failed')
  assert.equal(conventionalSignalExit.body.timedOut, false)

  const boundedOutput = await jsonRequest('/api/workspace/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      command: "printf '%*s' 90000 '' | tr ' ' x",
    }),
  })
  assert.equal(boundedOutput.response.status, 200)
  assert.equal(boundedOutput.body.outputTruncated, true)
  assert.ok(new TextEncoder().encode(
    `${boundedOutput.body.stdout}${boundedOutput.body.stderr}`,
  ).byteLength <= 65_536)
  assert.doesNotMatch(`${boundedOutput.body.stdout}${boundedOutput.body.stderr}`, /�/u)

  const created = await jsonRequest('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Integration session' }),
  })
  assert.equal(created.response.status, 201)
  const sessionId = created.body.session.id
  const workspaceAfterCandidateAttach = await rpc('workspace.list', {})
  assert.equal(workspaceAfterCandidateAttach.body.result.value.items[0].sessionIds[0], sessionId)
  assert.deepEqual(
    workspaceAfterCandidateAttach.body.result.value.items[0].sessionIds.slice(-2),
    [RELEASED_ARCHIVED_SESSION_ID, RELEASED_SESSION_ID],
  )

  const oversizedMessage = await jsonRequest(`/api/sessions/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '界'.repeat(65_536) }),
  })
  assert.equal(oversizedMessage.response.status, 413)

  const firstEvents = await turn(sessionId, 'remember alpha')
  assert.equal(firstEvents[0].type, 'agent/inbox/spliced')
  assert.equal(firstEvents[1].type, 'turn/start')
  assert.equal(firstEvents[2].type, 'agent/inbox/spliced')
  assert.equal(firstEvents[3].type, 'step/start')
  assert.equal(firstEvents[4].type, 'user/message')
  assert.equal(assistantText(firstEvents), 'remembered-alpha')
  assert.equal(firstEvents.at(-2).type, 'step/end')
  assert.deepEqual(firstEvents.at(-1).data.reason, { kind: 'completed' })
  const feedbackMessageId = firstEvents
    .find(event => event.type === 'assistant/message')?.data.message.id
  assert.equal(typeof feedbackMessageId, 'string')
  // Exercise the service's 8 KiB note boundary with JSON's six-byte control escapes.
  const maxFeedbackNote = '\u0001'.repeat(8_192)
  const savedFeedback = await typertRpc('messageFeedback', 'put', {
    request: {
      sessionId,
      messageId: feedbackMessageId,
      rating: 'positive',
      note: maxFeedbackNote,
      ifVersion: null,
    },
  })
  assert.equal(savedFeedback.body.result.ok, true, JSON.stringify(savedFeedback.body))
  assert.equal(savedFeedback.body.result.value.ok, true)
  const feedbackItem = savedFeedback.body.result.value.value
  assert.deepEqual(feedbackItem, {
    messageId: feedbackMessageId,
    rating: 'positive',
    note: maxFeedbackNote,
    version: feedbackItem.version,
    createdAt: feedbackItem.createdAt,
    updatedAt: feedbackItem.updatedAt,
  })
  const listedFeedback = await typertRpc('messageFeedback', 'list', {
    request: { sessionId },
  })
  assert.deepEqual(listedFeedback.body.result.value, {
    ok: true,
    value: { items: [feedbackItem] },
  })
  // A rejecting Edge handler on the direct fallback path must still produce a
  // correlated server-response RPC error envelope, not an HTTP-level failure.
  const malformedPrompt = await typertRpc('session', 'prompt', {
    request: { sessionId },
  })
  assert.equal(malformedPrompt.body.type, 'server-response')
  assert.equal(malformedPrompt.body.result.ok, false, JSON.stringify(malformedPrompt.body))
  assert.equal(typeof malformedPrompt.body.result.error.code, 'string')

  const secondEvents = await turn(sessionId, 'history check')
  assert.equal(assistantText(secondEvents), 'history-ok')
  assert.equal(secondEvents[0].seq, firstEvents.at(-1).seq + 2)

  const file = await request('/api/workspace/file?path=/workspace/session.txt', {
    method: 'PUT',
    body: 'cloudflare-tool-value',
  })
  assert.equal(file.status, 200)
  const toolEvents = await turn(sessionId, 'run the tool')
  assert.equal(toolResultText(toolEvents.find(event => event.type === 'tool/result')),
    'cloudflare-tool-value')
  assert.equal(toolEvents.filter(event => event.type === 'step/start').length, 2)

  const searchEvents = await turn(sessionId, 'use web search')
  assert.equal(assistantText(searchEvents), 'search-finished')
  assert.equal(searchEvents.filter(event => event.type === 'step/start').length, 2)
  assert.equal(searchEvents.find(event => event.type === 'tool/call')?.data.name, 'web_search')
  const searchResult = searchEvents.find(event => event.type === 'tool/result')
  assert.equal(searchResult?.data.meta.sources[0].url, 'https://example.com/current')
  const searchRequestEvent = searchEvents.find(
    event => event.type === 'web/deepseek-search-llm-request',
  )
  assert.equal(searchRequestEvent?.data.endpoint, `${mock.url}/anthropic/v1/messages`)
  assert.equal(mock.searchRequests.length, 1)
  assert.equal(mock.searchRequests[0].apiKey, 'integration-test-key')
  assert.equal(mock.searchRequests[0].authorization, 'Bearer integration-test-key')
  assert.doesNotMatch(JSON.stringify(searchEvents), /integration-test-key/u)

  const fetchEvents = await turn(sessionId, 'use web fetch')
  assert.equal(assistantText(fetchEvents), 'fetch-finished')
  assert.equal(fetchEvents.filter(event => event.type === 'step/start').length, 2)
  assert.equal(fetchEvents.find(event => event.type === 'tool/call')?.data.name, 'web_fetch')
  const fetchResult = fetchEvents.find(event => event.type === 'tool/result')
  assert.equal(fetchResult?.data.error.code, 'WEB_BLOCKED_URL')
  assert.equal(fetchResult?.data.message.content[0].isError, true)
  assert.match(toolResultText(fetchResult), /fetch blocked|private or local target/u)

  const replay = await request(
    `/api/sessions/${sessionId}/events?after=${firstEvents.at(-1).seq}&limit=2`,
  )
  assert.equal(replay.status, 200)
  const replayedEvents = parseEvents(await replay.text())
  assert.equal(replayedEvents.length, 2)
  assert.equal(replay.headers.get('x-dsh-edge-has-more'), 'true')
  assert.equal(replay.headers.get('x-dsh-edge-next-after'), String(replayedEvents.at(-1).seq))
  assert.equal(replayedEvents[0].type, 'session/end-seed')
  assert.equal(replayedEvents[1].seq, secondEvents[0].seq)
  const replayRemainder = await request(
    `/api/sessions/${sessionId}/events?after=${replayedEvents.at(-1).seq}`,
  )
  const remainingEvents = parseEvents(await replayRemainder.text())
  assert.equal(replayRemainder.headers.get('x-dsh-edge-has-more'), 'false')
  assert.equal(remainingEvents.at(-1).seq, fetchEvents.at(-1).seq)
  const invalidReplayLimit = await jsonRequest(
    `/api/sessions/${sessionId}/events?limit=257`,
  )
  assert.equal(invalidReplayLimit.response.status, 400)

  const turnRequests = () => mock.requests.filter(r => r.max_tokens !== 32)
  const turnRequestCount = turnRequests().length
  const slowResponse = await request(`/api/sessions/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'slow response' }),
  })
  await waitFor(() => turnRequests().length === turnRequestCount + 1)
  const busy = await jsonRequest(`/api/sessions/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'must be rejected' }),
  })
  assert.equal(busy.response.status, 409)
  assert.equal(busy.body.code, 'BUSY')
  const cancelled = await jsonRequest(`/api/sessions/${sessionId}/cancel`, { method: 'POST' })
  assert.equal(cancelled.response.status, 202)
  const cancelledEvents = parseEvents(await slowResponse.text())
  assert.equal(cancelledEvents.at(-1).type, 'turn/end')
  assert.deepEqual(cancelledEvents.at(-1).data.reason, {
    kind: 'aborted',
    reason: { kind: 'user' },
  })

  const legacySelector = await jsonRequest('/api/sessions', {
    headers: { 'x-dsh-edge-instance': 'integration-isolated' },
  })
  assert.equal(legacySelector.response.status, 400)
  assert.match(legacySelector.body.error, /one owner workspace/u)

  await worker.stop()
  worker = await startWorker()
  const restored = await jsonRequest(`/api/sessions/${sessionId}`)
  assert.equal(restored.response.status, 200)
  assert.equal(restored.body.session.status, 'idle')
  assert.equal(Object.hasOwn(restored.body, 'messages'), false)
  const restoredFeedback = await typertRpc('messageFeedback', 'list', {
    request: { sessionId },
  })
  assert.deepEqual(restoredFeedback.body.result.value, {
    ok: true,
    value: { items: [feedbackItem] },
  })
  const restoredFile = await request('/api/workspace/file?path=/workspace/session.txt')
  assert.equal(restoredFile.status, 200)
  assert.equal(await restoredFile.text(), 'cloudflare-tool-value')
  const restoredReleasedFile = await request(
    '/api/workspace/file?path=/workspace/released.txt',
  )
  assert.equal(restoredReleasedFile.status, 200)
  assert.equal(await restoredReleasedFile.text(), 'dsh-edge-0.1.3-vfs')
  const restoredUpgradedFile = await request(
    '/api/workspace/file?path=/workspace/after-upgrade.txt',
  )
  assert.equal(restoredUpgradedFile.status, 200)
  assert.equal(await restoredUpgradedFile.text(), 'current-runtime-write')
  const restoredReleasedSession = await jsonRequest(`/api/sessions/${RELEASED_SESSION_ID}`)
  assert.equal(restoredReleasedSession.response.status, 200)
  assert.equal(restoredReleasedSession.body.session.status, 'idle')
  const restoredReleasedBlank = await jsonRequest(
    `/api/sessions/${RELEASED_ARCHIVED_SESSION_ID}`,
  )
  assert.equal(restoredReleasedBlank.response.status, 200)
  assert.equal(restoredReleasedBlank.body.session.status, 'idle')
  const restoredReleasedBlankHistory = await request(
    `/api/sessions/${RELEASED_ARCHIVED_SESSION_ID}/events`,
  )
  assert.equal(restoredReleasedBlankHistory.status, 200)
  assert.equal(
    assistantText(parseEvents(await restoredReleasedBlankHistory.text())),
    'remembered-alpha',
  )
  const restoredReleasedWorkspace = await rpc('workspace.list', {})
  assert.equal(
    restoredReleasedWorkspace.body.result.value.items[0].title,
    'Upgraded 0.1.3 workspace',
  )
  assert.deepEqual(restoredReleasedWorkspace.body.result.value.archivedSessionIds, [
    RELEASED_ARCHIVED_SESSION_ID,
  ])
  assert.equal(
    restoredReleasedWorkspace.body.result.value.items[0].sessionIds.includes(RELEASED_SESSION_ID),
    true,
  )
  const restoredReleasedBlankList = await rpc('session.list', {})
  const restoredReleasedBlankSummary = restoredReleasedBlankList.body.result.value.items
    .find(item => item.sessionId === RELEASED_ARCHIVED_SESSION_ID)
  assert.equal(restoredReleasedBlankSummary.blank, false)

  const resumedEvents = await turn(sessionId, 'history after restart')
  assert.equal(assistantText(resumedEvents), 'history-ok')
  assert.equal(resumedEvents[0].seq, cancelledEvents.at(-1).seq + 2)
  const resumedReplay = await request(
    `/api/sessions/${sessionId}/events?after=${cancelledEvents.at(-1).seq}`,
  )
  const replayedResume = parseEvents(await resumedReplay.text())
  assert.equal(replayedResume[0].type, 'session/end-seed')
  assert.equal(replayedResume[1].seq, resumedEvents[0].seq)

  const turnRequestsSnapshot = turnRequests()
  assert.equal(turnRequestsSnapshot.length, 13)
  assert.ok(turnRequestsSnapshot.every(request => request.max_tokens === 16_384))
  assert.ok(turnRequestsSnapshot.every(request => request.model === 'deepseek-v4-pro'))
  assert.ok(turnRequestsSnapshot.every(request => request.reasoning_effort === 'high'))
  assert.ok(mock.requests.some(request => request.messages.some(message =>
    message.role === 'assistant' && message.content === 'remembered-alpha')))

  const secondCreated = await jsonRequest('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Second paginated session' }),
  })
  assert.equal(secondCreated.response.status, 201)
  const firstSessionPage = await jsonRequest('/api/sessions?limit=1')
  assert.equal(firstSessionPage.response.status, 200)
  assert.equal(firstSessionPage.body.sessions.length, 1)
  assert.equal(firstSessionPage.body.hasMore, true)
  assert.equal(typeof firstSessionPage.body.nextAfter, 'string')
  const secondSessionPage = await jsonRequest(
    `/api/sessions?limit=100&after=${encodeURIComponent(firstSessionPage.body.nextAfter)}`,
  )
  assert.equal(secondSessionPage.response.status, 200)
  assert.equal(secondSessionPage.body.sessions.length >= 1, true)
  assert.equal(secondSessionPage.body.sessions.some(
    session => session.id === firstSessionPage.body.sessions[0].id,
  ), false)
  assert.equal(secondSessionPage.body.hasMore, false)
  const invalidSessionListLimit = await jsonRequest('/api/sessions?limit=101')
  assert.equal(invalidSessionListLimit.response.status, 400)
  const invalidSessionListCursor = await jsonRequest('/api/sessions?after=missing-session')
  assert.equal(invalidSessionListCursor.response.status, 400)

  let mux = await openDownlink('/api/events.mux')
  let host = await openDownlink('/api/events.host')
  const expiringHost = await openDownlink('/api/events.host', createOwnerSessionCookie(2))
  const described = await rpc('host.describe', {})
  assert.equal(described.response.status, 200)
  assert.equal(described.body.result.ok, true)
  assert.equal(described.body.result.value.cwd, '/workspace')
  assert.equal(described.body.result.value.model, 'deepseek-v4-pro')
  // The upstream forwarded-event source (dsh-api-remotes) registered with the
  // gateway inside the Worker: the browser's `$events` stream opens with the
  // ready frame, and the gateway-owned `$events/result` unary endpoint reaches
  // the gateway through the Edge connection seam instead of Remote invoke().
  const remoteMux = await openDownlink('/api/remote.mux')
  remoteMux.send({ type: 'open', streamId: 'events-1', endpoint: '$events', payload: { args: {} } })
  const eventsReady = await remoteMux.next(frame => frame.type === 'item' && frame.streamId === 'events-1')
  assert.equal(eventsReady.value.type, 'ready')
  assert.equal(typeof eventsReady.value.clientId, 'string')
  assert.equal(typeof eventsReady.value.host.home, 'string')
  const staleEventResult = await jsonRequest('/api/$events/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rpcId: 'events-result-1',
      payload: { args: { clientId: eventsReady.value.clientId, eventId: 'missing-event', outcome: { kind: 'next' } } },
    }),
  })
  assert.equal(staleEventResult.response.status, 200)
  assert.deepEqual(staleEventResult.body, { type: 'server-response', rpcId: 'events-result-1', result: { ok: true } })
  const unknownClientResult = await jsonRequest('/api/$events/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rpcId: 'events-result-2',
      payload: { args: { clientId: 'unknown-client', eventId: 'missing-event', outcome: { kind: 'next' } } },
    }),
  })
  assert.equal(unknownClientResult.response.status, 200)
  assert.equal(unknownClientResult.body.result.ok, false)
  assert.match(unknownClientResult.body.result.error.message, /no active event stream/u)
  remoteMux.send({ type: 'cancel', streamId: 'events-1' })
  remoteMux.close()
  const preset = await rpc('agentPreset.read', { agentPreset: 'dsh-edge' })
  assert.equal(preset.body.result.ok, true)
  assert.match(preset.body.result.value.content, /Effective dsh-edge composition/u)
  assert.match(
    preset.body.result.value.content,
    new RegExp(`shell: "just-bash-${runtimeMode}"`, 'u'),
  )
  assert.match(preset.body.result.value.content, /defaultId: "deepseek-v4-pro"/u)
  assert.match(preset.body.result.value.content, /selectionScope: session/u)
  assert.match(preset.body.result.value.content, /id: "deepseek-v4-flash"/u)
  assert.match(preset.body.result.value.content, /id: "deepseek-v4-flash-vision-exp"/u)
  assert.match(preset.body.result.value.content, /configured: true/u)
  assert.match(preset.body.result.value.content, /id: web_search/u)
  assert.doesNotMatch(preset.body.result.value.content, /integration-test-key/u)
  const credential = await rpc('credentials.describe', {
    refs: ['DEEPSEEK_API_KEY'],
  })
  assert.deepEqual(credential.body.result.value.credentials.DEEPSEEK_API_KEY, {
    configured: true,
    source: 'worker-secret',
    writable: true,
  })
  await new Promise(resolve => { setTimeout(resolve, 2_500) })

  const protocolCreated = await rpc('session.create', { workspaceId: 'edge-workspace' })
  assert.equal(protocolCreated.body.result.ok, true)
  const protocolSessionId = protocolCreated.body.result.value.sessionId
  await expiringHost.expectNone(message =>
    message.payload.type === 'host/session-added'
      && message.payload.sessionId === protocolSessionId,
  500)
  const durableBlank = await jsonRequest(`/api/sessions/${protocolSessionId}`)
  assert.equal(durableBlank.response.status, 200)
  assert.equal(durableBlank.body.session.id, protocolSessionId)
  assert.equal(durableBlank.body.session.title, null)
  const subscribed = await mux.next(message =>
    message.payload.type === 'session/subscribed'
      && message.payload.sessionId === protocolSessionId)
  assert.equal(subscribed.payload.lastSeq, -1)
  const added = await host.next(message =>
    message.payload.type === 'host/session-added'
      && message.payload.sessionId === protocolSessionId)
  assert.equal(added.payload.blank, true)
  const workspaceChanged = await host.next(message =>
    message.payload.type === 'host/workspace-changed'
      && message.payload.workspace.sessionIds.includes(protocolSessionId))
  assert.equal(workspaceChanged.payload.workspace.workspaceId, 'edge-workspace')

  const commandCatalog = await rpc('commands/list', {
    args: { agentId: protocolSessionId },
  })
  assert.equal(commandCatalog.body.result.ok, true)
  assert.deepEqual(commandCatalog.body.result.value, [])
  assert.equal(commandCatalog.response.headers.get('access-control-allow-origin'), '*')
  assert.doesNotMatch(
    commandCatalog.response.headers.get('access-control-expose-headers') ?? '',
    /x-dsh-edge-instance/u,
  )
  assert.equal(commandCatalog.response.headers.get('x-dsh-edge-instance'), null)

  const putSkill = await jsonRequest('/api/skills', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'test-skill',
      description: 'Integration test skill',
      content: 'Step 1: verify.\nStep 2: done.',
      whenToUse: 'When testing',
    }),
  })
  assert.equal(putSkill.response.status, 200)
  assert.deepEqual(putSkill.body, { ok: true, name: 'test-skill' })
  const listSkills = await jsonRequest('/api/skills')
  assert.equal(listSkills.response.status, 200)
  assert.deepEqual(listSkills.body.skills, ['test-skill'])

  const globalModels = await rpc('llm.models', {})
  assert.equal(globalModels.body.result.ok, true)
  assert.deepEqual(
    globalModels.body.result.value.groups.flatMap(group => group.models.map(model => model.id)),
    ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
  )
  const initialSessionModels = await rpc('session.models', { sessionId: protocolSessionId })
  assert.equal(initialSessionModels.body.result.ok, true)
  assert.deepEqual(initialSessionModels.body.result.value.current, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  })
  const selectedVision = await rpc('session.selectModel', {
    sessionId: protocolSessionId,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash-vision-exp',
  })
  assert.equal(selectedVision.body.result.ok, true)
  assert.deepEqual(selectedVision.body.result.value.selected, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash-vision-exp',
    reasoningEffort: 'high',
  })

  const protocolList = await rpc('session.list', {})
  assert.equal(protocolList.response.headers.get('access-control-allow-origin'), '*')
  const protocolSummary = protocolList.body.result.value.items
    .find(item => item.sessionId === protocolSessionId)
  assert.equal(protocolSummary.blank, true)
  assert.equal(protocolSummary.cwd, '/workspace')
  assert.equal(protocolSummary.projections.asOfSeq, -1)
  assert.deepEqual(protocolSummary.projections.values.imageLimits.mediaTypes, [
    'image/png',
    'image/jpeg',
  ])

  mux.close()
  host.close()
  await worker.stop()
  worker = await startWorker()
  const restoredSkills = await jsonRequest('/api/skills')
  assert.deepEqual(restoredSkills.body.skills, ['test-skill'])
  const deletedSkill = await jsonRequest('/api/skills', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'test-skill' }),
  })
  assert.equal(deletedSkill.body.deleted, true)
  const emptySkills = await jsonRequest('/api/skills')
  assert.deepEqual(emptySkills.body.skills, [])
  mux = await openDownlink('/api/events.mux')
  host = await openDownlink('/api/events.host')
  const restoredBlankList = await rpc('session.list', {})
  const restoredBlank = restoredBlankList.body.result.value.items
    .find(item => item.sessionId === protocolSessionId)
  assert.equal(restoredBlank.blank, true)
  assert.equal(restoredBlank.projections.asOfSeq, -1)
  const restoredSessionModels = await rpc('session.models', { sessionId: protocolSessionId })
  assert.deepEqual(restoredSessionModels.body.result.value.current, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash-vision-exp',
    reasoningEffort: 'high',
  })
  const restoredDefaultModel = await rpc('session.selectModel', {
    sessionId: protocolSessionId,
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  })
  assert.equal(restoredDefaultModel.body.result.ok, true)

  const blankFork = await rpc('session.fork', { sessionId: protocolSessionId })
  assert.equal(blankFork.body.result.ok, false)
  assert.equal(blankFork.body.result.error.code, 'fork-unavailable')
  assert.equal(blankFork.body.result.error.details.sessionId, protocolSessionId)

  const invalidRename = await rpc('session.rename', {
    sessionId: protocolSessionId,
    title: '\u200b',
  })
  assert.equal(invalidRename.body.result.ok, false)
  assert.equal(invalidRename.body.result.error.code, 'title-invalid')
  assert.equal(invalidRename.body.result.error.details.sessionId, protocolSessionId)

  // The Typert client mints its own requestId and reconciles its optimistic
  // user message against message.source.rpcId, so the persisted message must
  // carry that id rather than the transport envelope's rpcId.
  const protocolRequestId = `client-minted-${crypto.randomUUID()}`
  const protocolPrompt = await typertRpc('session', 'prompt', {
    request: {
      requestId: protocolRequestId,
      sessionId: protocolSessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'upstream protocol path' }],
      clientTimeZone: 'UTC',
    },
  })
  assert.equal(protocolPrompt.body.result.ok, true, JSON.stringify(protocolPrompt.body))
  assert.equal(protocolPrompt.body.result.value.accepted, true)
  assert.notEqual(protocolPrompt.rpcId, protocolRequestId)
  const admittedHistory = await rpc('session.history', { sessionId: protocolSessionId })
  const admittedPrompt = admittedHistory.body.result.value.events
    .find(entry => entry.event.type === 'agent/inbox/spliced'
      && entry.event.data.inserted?.some(message => message.source.rpcId === protocolRequestId))
  assert.notEqual(admittedPrompt, undefined)
  assert.equal(admittedHistory.body.result.value.events.some(entry =>
    entry.event.type === 'agent/inbox/spliced'
      && entry.event.data.inserted?.some(message => message.source.rpcId === protocolPrompt.rpcId)), false)
  await host.next(message => message.payload.type === 'host/session-status'
    && message.payload.sessionId === protocolSessionId
    && message.payload.running === true)
  const protocolAssistant = await mux.next(message =>
    message.payload.type === 'session/event'
      && message.payload.sessionId === protocolSessionId
      && message.payload.event.type === 'assistant/message')
  assert.equal(assistantText([protocolAssistant.payload.event]), 'remembered-alpha')
  await mux.next(message => message.payload.type === 'session/event'
    && message.payload.sessionId === protocolSessionId
    && message.payload.event.type === 'turn/end')
  await host.next(message => message.payload.type === 'host/session-status'
    && message.payload.sessionId === protocolSessionId
    && message.payload.running === false)

  const protocolHistory = await rpc('session.history', { sessionId: protocolSessionId })
  assert.equal(protocolHistory.body.result.ok, true)
  const protocolUser = protocolHistory.body.result.value.events
    .find(entry => entry.event.type === 'user/message')
  assert.equal(protocolUser.event.data.source.rpcId, protocolRequestId)
  const protocolPromptProjection = await mux.next(message =>
    message.payload.type === 'session/projection'
      && message.payload.sessionId === protocolSessionId
      && message.payload.key === 'sessionListMetadata'
      && message.payload.seq === protocolUser.event.seq)
  assert.deepEqual(protocolPromptProjection.payload.value, {
    blank: false,
    lastPromptAt: protocolUser.event.time,
  })
  assert.equal(protocolHistory.body.result.value.hasMore, false)
  const protocolSearch = await rpc('session.search', { query: 'remembered-alpha' })
  assert.equal(protocolSearch.body.result.ok, true)
  assert.equal(protocolSearch.body.result.value.hasMore, false)
  assert.ok(protocolSearch.body.result.value.items.some(item =>
    item.sessionId === protocolSessionId && item.snippet === 'remembered-alpha'))
  const emptySearch = await rpc('session.search', { query: 'absent-search-token' })
  assert.deepEqual(emptySearch.body.result, {
    ok: true,
    value: { items: [], hasMore: false },
  })
  const protocolRequestHeader = protocolHistory.body.result.value.events
    .findLast(entry => entry.event.type === 'request/header')
  assert.equal(protocolRequestHeader.event.data.header.config.provider, 'deepseek-official')
  assert.equal(protocolRequestHeader.event.data.header.config.model, 'deepseek-v4-pro')
  assert.equal(protocolRequestHeader.event.data.header.config.reasoningEffort, 'high')

  // Once a turn has flushed its request/header, the upstream session log is the
  // durable source of truth; the Edge pre-turn bridge may be retired safely.
  mux.close()
  host.close()
  await worker.stop()
  worker = await startWorker()
  mux = await openDownlink('/api/events.mux')
  host = await openDownlink('/api/events.host')
  const canonicalSessionModels = await rpc('session.models', { sessionId: protocolSessionId })
  assert.deepEqual(canonicalSessionModels.body.result.value.current, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  })

  const forked = await rpc('session.fork', {
    sessionId: protocolSessionId,
    atSeq: protocolUser.event.seq,
  })
  assert.equal(forked.body.result.ok, true)
  const forkedSessionId = forked.body.result.value.sessionId
  const forkAdded = await host.next(message => message.payload.type === 'host/session-added'
    && message.payload.sessionId === forkedSessionId)
  assert.equal(forkAdded.payload.parentSessionId, protocolSessionId)
  const renamedFork = await rpc('session.rename', {
    sessionId: forkedSessionId,
    title: 'Protocol path (2)',
  })
  assert.equal(renamedFork.body.result.ok, true)
  assert.equal(renamedFork.body.result.value.title, 'Protocol path (2)')
  const forkTitle = await mux.next(message => message.payload.type === 'session/event'
    && message.payload.sessionId === forkedSessionId
    && message.payload.event.type === 'session/title')
  assert.equal(forkTitle.payload.event.data.title, 'Protocol path (2)')
  const forkTitleProjection = await mux.next(message =>
    message.payload.type === 'session/projection'
      && message.payload.sessionId === forkedSessionId
      && message.payload.key === 'title'
      && message.payload.seq === forkTitle.payload.event.seq)
  assert.equal(forkTitleProjection.payload.value, 'Protocol path (2)')
  await mux.expectNone(message => message.payload.sessionId === forkedSessionId
    && ((message.payload.type === 'session/event'
      && message.payload.event.seq === forkTitle.payload.event.seq)
      || (message.payload.type === 'session/projection'
        && message.payload.seq === forkTitle.payload.event.seq)))
  const forkHistory = await rpc('session.history', { sessionId: forkedSessionId })
  assert.equal(forkHistory.body.result.ok, true)
  assert.equal(forkHistory.body.result.value.events.at(-1).event.type, 'session/title')
  assert.equal(
    forkHistory.body.result.value.events.some(entry => entry.event.type === 'session/end-seed'),
    true,
  )
  const listWithFork = await rpc('session.list', {})
  const forkSummary = listWithFork.body.result.value.items
    .find(item => item.sessionId === forkedSessionId)
  assert.equal(forkSummary.parentSessionId, protocolSessionId)
  assert.equal(forkSummary.projections.values.title, 'Protocol path (2)')

  const missingArchive = await rpc('workspace.archiveSession', {
    sessionId: 'session-ghost',
  })
  assert.equal(missingArchive.body.result.ok, false)
  assert.equal(missingArchive.body.result.error.code, 'session-not-found')
  const archivedFork = await rpc('workspace.archiveSession', {
    sessionId: forkedSessionId,
  })
  assert.equal(archivedFork.body.result.ok, true)
  assert.deepEqual(archivedFork.body.result.value.archivedSessionIds, [
    RELEASED_ARCHIVED_SESSION_ID,
    forkedSessionId,
  ])
  const archivedFrame = await host.next(message =>
    message.payload.type === 'host/archived-sessions-changed')
  assert.deepEqual(archivedFrame.payload.archivedSessionIds, [
    RELEASED_ARCHIVED_SESSION_ID,
    forkedSessionId,
  ])
  const archiveBaseline = await rpc('workspace.list', {})
  assert.equal(archiveBaseline.body.result.ok, true)
  assert.deepEqual(archiveBaseline.body.result.value.archivedSessionIds, [
    RELEASED_ARCHIVED_SESSION_ID,
    forkedSessionId,
  ])
  const idempotentArchive = await rpc('workspace.archiveSession', {
    sessionId: forkedSessionId,
  })
  assert.equal(idempotentArchive.body.result.ok, true)
  assert.deepEqual(idempotentArchive.body.result.value.archivedSessionIds, [
    RELEASED_ARCHIVED_SESSION_ID,
    forkedSessionId,
  ])

  const traversalWorkspace = await rpc('workspace.create', {
    path: '/workspace/aliases/../projects/./deep/',
  })
  assert.equal(traversalWorkspace.body.result.ok, true)
  assert.equal(traversalWorkspace.body.result.value.workspace.path, '/workspace/projects/deep')
  const aliasWorkspace = await rpc('workspace.create', {
    path: '/workspace/projects/deep',
  })
  assert.equal(aliasWorkspace.body.result.ok, true)
  assert.equal(aliasWorkspace.body.result.value.created, false)
  assert.equal(
    aliasWorkspace.body.result.value.workspace.workspaceId,
    traversalWorkspace.body.result.value.workspace.workspaceId,
  )
  const removedTraversalWorkspace = await rpc('workspace.delete', {
    workspaceId: traversalWorkspace.body.result.value.workspace.workspaceId,
  })
  assert.equal(removedTraversalWorkspace.body.result.ok, true)
  const removedTraversalFrame = await host.next(message =>
    message.payload.type === 'host/workspace-removed'
      && message.payload.workspaceId === traversalWorkspace.body.result.value.workspace.workspaceId)
  assert.ok(removedTraversalFrame)

  const renamedWorkspace = await rpc('workspace.rename', {
    workspaceId: 'edge-workspace',
    title: 'Edge project',
  })
  assert.equal(renamedWorkspace.body.result.ok, true)
  assert.equal(renamedWorkspace.body.result.value.workspace.title, 'Edge project')
  const renamedWorkspaceFrame = await host.next(message =>
    message.payload.type === 'host/workspace-changed'
      && message.payload.workspace.title === 'Edge project')
  assert.equal(renamedWorkspaceFrame.payload.workspace.workspaceId, 'edge-workspace')

  const reorderedWorkspace = await rpc('workspace.insertSessionBefore', {
    workspaceId: 'edge-workspace',
    sessionId: protocolSessionId,
    beforeSessionId: forkedSessionId,
  })
  assert.equal(reorderedWorkspace.body.result.ok, true)
  assert.ok(reorderedWorkspace.body.result.value.workspace.sessionIds.indexOf(protocolSessionId)
    < reorderedWorkspace.body.result.value.workspace.sessionIds.indexOf(forkedSessionId))
  const reorderedWorkspaceFrame = await host.next(message =>
    message.payload.type === 'host/workspace-changed'
      && message.payload.workspace.sessionIds[0] === protocolSessionId)
  assert.equal(reorderedWorkspaceFrame.payload.workspace.title, 'Edge project')

  const invalidWorkspaceMove = await rpc('workspace.insertSessionBefore', {
    workspaceId: 'edge-workspace',
    sessionId: 'session-ghost',
  })
  assert.equal(invalidWorkspaceMove.body.result.ok, false)
  assert.equal(invalidWorkspaceMove.body.result.error.code, 'workspace-move-invalid')

  const deletedWorkspace = await rpc('workspace.delete', { workspaceId: 'edge-workspace' })
  assert.equal(deletedWorkspace.body.result.ok, true)
  const removedWorkspaceFrame = await host.next(message =>
    message.payload.type === 'host/workspace-removed')
  assert.equal(removedWorkspaceFrame.payload.workspaceId, 'edge-workspace')
  const withoutWorkspace = await rpc('workspace.list', {})
  assert.deepEqual(withoutWorkspace.body.result.value.items, [])
  assert.deepEqual(withoutWorkspace.body.result.value.archivedSessionIds, [
    RELEASED_ARCHIVED_SESSION_ID,
    forkedSessionId,
  ])
  const missingWorkspaceSession = await rpc('session.create', { workspaceId: 'edge-workspace' })
  assert.equal(missingWorkspaceSession.body.result.ok, false)
  assert.equal(missingWorkspaceSession.body.result.error.code, 'workspace-not-found')

  const recreatedWorkspace = await rpc('workspace.create', { path: '/workspace' })
  assert.equal(recreatedWorkspace.body.result.ok, true)
  assert.equal(recreatedWorkspace.body.result.value.created, true)
  assert.deepEqual(recreatedWorkspace.body.result.value.workspace.sessionIds, [])
  const recreatedWorkspaceFrame = await host.next(message =>
    message.payload.type === 'host/workspace-changed'
      && message.payload.workspace.title === 'workspace')
  assert.deepEqual(recreatedWorkspaceFrame.payload.workspace.sessionIds, [])

  // Multi-workspace: create a second workspace with a distinct path
  const secondWorkspace = await rpc('workspace.create', { path: '/workspace/project-b' })
  assert.equal(secondWorkspace.body.result.ok, true)
  assert.equal(secondWorkspace.body.result.value.created, true)
  assert.equal(secondWorkspace.body.result.value.workspace.path, '/workspace/project-b')
  const secondWorkspaceId = secondWorkspace.body.result.value.workspace.workspaceId
  await host.next(message =>
    message.payload.type === 'host/workspace-changed'
      && message.payload.workspace.workspaceId === secondWorkspaceId)

  // Session created under the second workspace gets its cwd
  const secondWorkspaceSession = await rpc('session.create', { workspaceId: secondWorkspaceId })
  assert.equal(secondWorkspaceSession.body.result.ok, true)
  const secondWorkspaceSessionId = secondWorkspaceSession.body.result.value.sessionId
  await host.next(message => message.payload.type === 'host/session-added'
    && message.payload.sessionId === secondWorkspaceSessionId)
  const secondWorkspaceList = await rpc('workspace.list', {})
  const secondItem = secondWorkspaceList.body.result.value.items
    .find(item => item.workspaceId === secondWorkspaceId)
  assert.ok(secondItem, 'second workspace should appear in the list')
  assert.ok(secondItem.sessionIds.includes(secondWorkspaceSessionId),
    'session should be attached to the second workspace')

  // Session under the second workspace has the correct cwd
  const sessionListForCwd = await rpc('session.list', {})
  const secondSessionSummary = sessionListForCwd.body.result.value.items
    .find(item => item.sessionId === secondWorkspaceSessionId)
  assert.equal(secondSessionSummary.cwd, '/workspace/project-b')

  // Reject session creation with invalid cwd (path traversal, outside /workspace)
  const traversalSession = await rpc('session.create', { cwd: '/workspace/../etc' })
  assert.equal(traversalSession.body.result.ok, false)
  assert.equal(traversalSession.body.result.error.code, 'workspace-invalid-path')
  const outsideSession = await rpc('session.create', { cwd: '/tmp' })
  assert.equal(outsideSession.body.result.ok, false)
  assert.equal(outsideSession.body.result.error.code, 'workspace-invalid-path')

  const retrySessionId = 'session-idempotent-workspace-attach'
  const ungroupedSession = await rpc('session.create', { sessionId: retrySessionId })
  assert.equal(ungroupedSession.body.result.ok, true)
  assert.equal(ungroupedSession.body.result.value.sessionId, retrySessionId)
  await host.next(message => message.payload.type === 'host/session-added'
    && message.payload.sessionId === retrySessionId)
  const beforeRetryWorkspace = await rpc('workspace.list', {})
  assert.equal(
    beforeRetryWorkspace.body.result.value.items[0].sessionIds.includes(retrySessionId),
    false,
  )
  const recreatedWorkspaceId = recreatedWorkspace.body.result.value.workspace.workspaceId
  const attachedRetry = await rpc('session.create', {
    sessionId: retrySessionId,
    workspaceId: recreatedWorkspaceId,
  })
  assert.equal(attachedRetry.body.result.ok, true)
  assert.equal(attachedRetry.body.result.value.sessionId, retrySessionId)
  const attachedRetryFrame = await host.next(message =>
    message.payload.type === 'host/workspace-changed'
      && message.payload.workspace.sessionIds.includes(retrySessionId))
  assert.equal(attachedRetryFrame.payload.workspace.workspaceId, recreatedWorkspaceId)
  const afterRetrySessions = await rpc('session.list', {})
  assert.equal(
    afterRetrySessions.body.result.value.items
      .filter(item => item.sessionId === retrySessionId).length,
    1,
  )

  const activeVision = await rpc('session.selectModel', {
    sessionId: protocolSessionId,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash-vision-exp',
  })
  assert.equal(activeVision.body.result.ok, true)
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4XmP4z8DwHwAFAAH/NQZ7kgAAAABJRU5ErkJggg=='
  const activePrompt = await rpc('session.prompt', {
    sessionId: protocolSessionId,
    mode: 'queue',
    content: [{ type: 'text', text: 'slow active protocol turn' }],
  })
  assert.equal(activePrompt.body.result.ok, true)
  const activeTurnStart = await mux.next(message => message.payload.type === 'session/event'
    && message.payload.sessionId === protocolSessionId
    && message.payload.event.type === 'turn/start'
    && message.payload.event.seq > protocolUser.event.seq)
  await mux.expectNone(message => message.payload.type === 'session/projection'
    && message.payload.sessionId === protocolSessionId
    && message.payload.key === 'sessionListMetadata'
    && message.payload.seq === activeTurnStart.payload.event.seq)
  await host.next(message => message.payload.type === 'host/session-status'
    && message.payload.sessionId === protocolSessionId
    && message.payload.running === true)
  const activeRename = await rpc('session.rename', {
    sessionId: protocolSessionId,
    title: 'Renamed while running',
  })
  assert.equal(activeRename.body.result.ok, true)
  const activeTitle = await mux.next(message => message.payload.type === 'session/event'
    && message.payload.sessionId === protocolSessionId
    && message.payload.event.type === 'session/title'
    && message.payload.event.data.title === 'Renamed while running')
  assert.equal(activeTitle.payload.event.seq, activeRename.body.result.value.seq)
  const activeTitleProjection = await mux.next(message =>
    message.payload.type === 'session/projection'
      && message.payload.sessionId === protocolSessionId
      && message.payload.key === 'title'
      && message.payload.seq === activeTitle.payload.event.seq)
  assert.equal(activeTitleProjection.payload.value, 'Renamed while running')
  const queuedPrompt = await rpc('session.prompt', {
    sessionId: protocolSessionId,
    mode: 'queue',
    content: [{ type: 'text', text: 'queued behind the active turn' }],
  })
  assert.equal(queuedPrompt.body.result.ok, true)
  const queuedSnapshot = await mux.next(message => message.payload.type === 'session/queue'
    && message.payload.sessionId === protocolSessionId
    && message.payload.items.some(item => item.message.source.rpcId === queuedPrompt.rpcId))
  await mux.expectNone(message => message.payload.sessionId === protocolSessionId
    && ((message.payload.type === 'session/event'
      && message.payload.event.seq === activeTitle.payload.event.seq)
      || (message.payload.type === 'session/projection'
        && message.payload.seq === activeTitle.payload.event.seq)))
  const queuedItem = queuedSnapshot.payload.items.find(
    item => item.message.source.rpcId === queuedPrompt.rpcId,
  )
  assert.equal(queuedItem.placement, 'queued')
  const editedQueue = await rpc('session.updateQueue', {
    sessionId: protocolSessionId,
    itemId: queuedItem.id,
    action: { kind: 'edit', content: [{ type: 'text', text: 'edited queued prompt' }] },
  })
  assert.equal(editedQueue.body.result.ok, true)
  const editedSnapshot = await mux.next(message => message.payload.type === 'session/queue'
    && message.payload.sessionId === protocolSessionId
    && message.payload.items.some(item => item.id === queuedItem.id
      && item.message.content[0]?.text === 'edited queued prompt'))
  assert.equal(editedSnapshot.payload.items.find(item => item.id === queuedItem.id).placement, 'queued')

  const queuedImagePrompt = await rpc('session.prompt', {
    sessionId: protocolSessionId,
    mode: 'queue',
    content: [
      { type: 'text', text: 'queued image caption' },
      { type: 'image', mediaType: 'image/png', data: imageBase64, name: 'queued.png' },
    ],
  })
  assert.equal(queuedImagePrompt.body.result.ok, true)
  const queuedImageSnapshot = await mux.next(message => message.payload.type === 'session/queue'
    && message.payload.sessionId === protocolSessionId
    && message.payload.items.some(item => item.message.source.rpcId === queuedImagePrompt.rpcId))
  const queuedImageItem = queuedImageSnapshot.payload.items.find(
    item => item.message.source.rpcId === queuedImagePrompt.rpcId,
  )
  const queuedImageBlock = queuedImageItem.message.content.find(block => block.type === 'image')
  assert.notEqual(queuedImageBlock, undefined)
  const editedImageQueue = await rpc('session.updateQueue', {
    sessionId: protocolSessionId,
    itemId: queuedImageItem.id,
    action: {
      kind: 'edit',
      content: [
        { type: 'text', text: 'edited queued image caption' },
        queuedImageBlock,
      ],
    },
  })
  assert.equal(editedImageQueue.body.result.ok, true)
  await mux.next(message => message.payload.type === 'session/queue'
    && message.payload.sessionId === protocolSessionId
    && message.payload.items.some(item => item.id === queuedImageItem.id
      && item.message.content[0]?.text === 'edited queued image caption'
      && item.message.content[1]?.type === 'image'))
  const injectedImageQueue = await rpc('session.updateQueue', {
    sessionId: protocolSessionId,
    itemId: queuedImageItem.id,
    action: {
      kind: 'edit',
      content: [{
        ...queuedImageBlock,
        attachment: {
          ...queuedImageBlock.attachment,
          attachmentId: `sha256:${'b'.repeat(64)}`,
        },
      }],
    },
  })
  assert.equal(injectedImageQueue.body.result.ok, false)
  assert.equal(
    injectedImageQueue.body.result.error.details.reason,
    'QUEUE_EDIT_ATTACHMENT_INVALID',
  )
  const removedImageQueue = await rpc('session.updateQueue', {
    sessionId: protocolSessionId,
    itemId: queuedImageItem.id,
    action: { kind: 'remove' },
  })
  assert.equal(removedImageQueue.body.result.ok, true)
  await mux.next(message => message.payload.type === 'session/queue'
    && message.payload.sessionId === protocolSessionId
    && !message.payload.items.some(item => item.id === queuedImageItem.id))

  const removablePrompt = await rpc('session.prompt', {
    sessionId: protocolSessionId,
    mode: 'queue',
    content: [{ type: 'text', text: 'remove this queued prompt' }],
  })
  const removableSnapshot = await mux.next(message => message.payload.type === 'session/queue'
    && message.payload.sessionId === protocolSessionId
    && message.payload.items.some(item => item.message.source.rpcId === removablePrompt.rpcId))
  const removableItem = removableSnapshot.payload.items.find(
    item => item.message.source.rpcId === removablePrompt.rpcId,
  )
  const removedQueue = await rpc('session.updateQueue', {
    sessionId: protocolSessionId,
    itemId: removableItem.id,
    action: { kind: 'remove' },
  })
  assert.equal(removedQueue.body.result.ok, true)
  await mux.next(message => message.payload.type === 'session/queue'
    && message.payload.sessionId === protocolSessionId
    && !message.payload.items.some(item => item.id === removableItem.id))

  const promotedQueue = await rpc('session.updateQueue', {
    sessionId: protocolSessionId,
    itemId: queuedItem.id,
    action: { kind: 'steer' },
  })
  assert.equal(promotedQueue.body.result.ok, true)
  const promotedSnapshot = await mux.next(message => message.payload.type === 'session/queue'
    && message.payload.sessionId === protocolSessionId
    && message.payload.items.some(item => item.id === queuedItem.id
      && item.placement === 'steering'))
  assert.equal(promotedSnapshot.payload.items.find(item => item.id === queuedItem.id).placement, 'steering')
  const missingQueueItem = await rpc('session.updateQueue', {
    sessionId: protocolSessionId,
    itemId: 'message-ghost',
    action: { kind: 'remove' },
  })
  assert.equal(missingQueueItem.body.result.ok, false)
  assert.equal(missingQueueItem.body.result.error.code, 'queue-item-not-found')
  const largeQueueEdit = await rpc('session.updateQueue', {
    sessionId: protocolSessionId,
    itemId: 'message-large-ghost',
    action: { kind: 'edit', content: [{ type: 'text', text: 'x'.repeat(9_000) }] },
  })
  assert.equal(largeQueueEdit.response.status, 200)
  assert.equal(largeQueueEdit.body.result.ok, false)
  assert.equal(largeQueueEdit.body.result.error.code, 'queue-item-not-found')
  const oversizedQueueEdit = await rpc('session.updateQueue', {
    sessionId: protocolSessionId,
    itemId: 'message-oversized-ghost',
    action: { kind: 'edit', content: [{ type: 'text', text: '界'.repeat(21_846) }] },
  })
  assert.equal(oversizedQueueEdit.response.status, 200)
  assert.equal(oversizedQueueEdit.body.result.ok, false)
  assert.equal(oversizedQueueEdit.body.result.error.code, 'attachment-error')
  assert.equal(oversizedQueueEdit.body.result.error.details.reason, 'QUEUE_EDIT_TEXT_TOO_LARGE')
  const steeredPrompt = await rpc('session.prompt', {
    sessionId: protocolSessionId,
    mode: 'steer',
    content: [{ type: 'text', text: 'steer the active turn' }],
  })
  assert.equal(steeredPrompt.body.result.ok, true)
  const steeredSnapshot = await mux.next(message => message.payload.type === 'session/queue'
    && message.payload.sessionId === protocolSessionId
    && message.payload.items.some(item => item.message.source.rpcId === steeredPrompt.rpcId))
  assert.equal(steeredSnapshot.payload.items.find(
    item => item.message.source.rpcId === steeredPrompt.rpcId,
  ).placement, 'steering')
  assert.equal(steeredSnapshot.payload.items.find(
    item => item.message.source.rpcId === queuedPrompt.rpcId,
  ).placement, 'steering')

  mux.close()
  mux = await openDownlink('/api/events.mux')
  await mux.next(message => message.payload.type === 'session/subscribed'
    && message.payload.sessionId === protocolSessionId)
  const restoredQueue = await mux.next(message => message.payload.type === 'session/queue'
    && message.payload.sessionId === protocolSessionId)
  assert.equal(restoredQueue.payload.items.find(
    item => item.message.source.rpcId === queuedPrompt.rpcId,
  ).placement, 'steering')
  assert.equal(restoredQueue.payload.items.find(
    item => item.message.source.rpcId === steeredPrompt.rpcId,
  ).placement, 'steering')
  mock.releaseSlowResponses()
  const activeAdmissionHistory = await rpc('session.history', {
    sessionId: protocolSessionId,
  })
  const queuedAdmission = activeAdmissionHistory.body.result.value.events
    .find(entry => entry.event.type === 'agent/inbox/spliced'
      && entry.event.data.inserted?.some(message => message.source.rpcId === queuedPrompt.rpcId))
  assert.notEqual(queuedAdmission, undefined)
  assert.equal(queuedAdmission.event.data.target, 'next-turn')
  const steeredAdmission = activeAdmissionHistory.body.result.value.events
    .find(entry => entry.event.type === 'agent/inbox/spliced'
      && entry.event.data.inserted?.some(message => message.source.rpcId === steeredPrompt.rpcId))
  assert.notEqual(steeredAdmission, undefined)
  assert.equal(steeredAdmission.event.data.target, 'next-step')
  await host.next(message => message.payload.type === 'host/session-status'
    && message.payload.sessionId === protocolSessionId
    && message.payload.running === false)

  const imageSessionId = 'session-image'
  const createdImageSession = await rpc('session.create', { sessionId: imageSessionId })
  assert.equal(createdImageSession.body.result.ok, true)
  const imageModel = await rpc('session.selectModel', {
    sessionId: imageSessionId,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash-vision-exp',
  })
  assert.equal(imageModel.body.result.ok, true)
  const imagePrompt = await rpc('session.prompt', {
    sessionId: imageSessionId,
    mode: 'queue',
    content: [
      { type: 'text', text: 'describe image' },
      { type: 'image', mediaType: 'image/png', data: imageBase64, name: 'pixel.png' },
    ],
  })
  assert.equal(imagePrompt.body.result.ok, true)
  await mux.next(message => message.payload.type === 'session/event'
    && message.payload.sessionId === imageSessionId
    && message.payload.event.type === 'turn/end')
  const imageApiRequest = mock.requests.find(req =>
    req.messages.some(msg => Array.isArray(msg.content) && msg.content.some(part =>
      part.type === 'image_url')))
  assert.ok(imageApiRequest, 'expected at least one API request with an image_url part')
  const imageRequestContent = imageApiRequest.messages.findLast(msg => msg.role === 'user').content
  assert.ok(Array.isArray(imageRequestContent) && imageRequestContent.some(part =>
    part.type === 'image_url' && typeof part.image_url?.url === 'string'))
  const imageHistory = await rpc('session.history', { sessionId: imageSessionId })
  const imageUser = imageHistory.body.result.value.events
    .find(entry => entry.event.type === 'user/message')
  const imageRef = imageUser.event.data.content
    .find(block => block.type === 'image').attachment
  assert.match(imageRef.attachmentId, /^sha256:[a-f0-9]{64}$/u)
  const imageRead = await rpc('session.attachment', {
    sessionId: imageSessionId,
    attachmentId: imageRef.attachmentId,
  })
  assert.equal(imageRead.body.result.ok, true)
  assert.equal(imageRead.body.result.value.data, imageBase64)
  const crossSessionRead = await rpc('session.attachment', {
    sessionId: retrySessionId,
    attachmentId: imageRef.attachmentId,
  })
  assert.equal(crossSessionRead.body.result.ok, false)
  assert.equal(crossSessionRead.body.result.error.details.reason, 'ATTACHMENT_NOT_REFERENCED')
  const incompatibleModel = await rpc('session.selectModel', {
    sessionId: imageSessionId,
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  })
  assert.equal(incompatibleModel.body.result.ok, false)
  assert.equal(incompatibleModel.body.result.error.code, 'model-unavailable')
  const imageFork = await rpc('session.fork', {
    sessionId: imageSessionId,
    atSeq: imageUser.event.seq,
  })
  assert.equal(imageFork.body.result.ok, true)
  const forkedImageRead = await rpc('session.attachment', {
    sessionId: imageFork.body.result.value.sessionId,
    attachmentId: imageRef.attachmentId,
  })
  assert.equal(forkedImageRead.body.result.ok, true)
  assert.equal(forkedImageRead.body.result.value.data, imageBase64)
  mux.close()
  host.close()

  await worker.stop()
  worker = await startWorker({
    DEEPSEEK_BASE_URL: 'http://[',
    DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS: '1',
    DSH_EDGE_MAX_COMMAND_TIMEOUT_MS: '1',
  })
  const restoredArchive = await rpc('workspace.list', {})
  assert.equal(restoredArchive.body.result.ok, true)
  assert.deepEqual(restoredArchive.body.result.value.archivedSessionIds, [
    RELEASED_ARCHIVED_SESSION_ID,
    forkedSessionId,
  ])
  const restoredImage = await rpc('session.attachment', {
    sessionId: imageSessionId,
    attachmentId: imageRef.attachmentId,
  })
  assert.equal(restoredImage.body.result.ok, true)
  assert.equal(restoredImage.body.result.value.data, imageBase64)
  const textModelAfterRemovedImage = await rpc('session.selectModel', {
    sessionId: protocolSessionId,
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  })
  assert.equal(textModelAfterRemovedImage.body.result.ok, true)
  const timedOut = await jsonRequest('/api/workspace/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'sleep 1' }),
  })
  assert.equal(timedOut.response.status, 200)
  assert.equal(timedOut.body.timedOut, true)
  const invalidBaseURL = await jsonRequest(`/api/sessions/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'must fail before SSE' }),
  })
  assert.equal(invalidBaseURL.response.status, 500)
  assert.match(invalidBaseURL.response.headers.get('content-type'), /^application\/json/u)
  assert.equal(invalidBaseURL.body.error, 'Internal runtime error.')
  const invalidProtocolPrompt = await rpc('session.prompt', {
    sessionId: protocolSessionId,
    mode: 'queue',
    content: [{ type: 'text', text: 'invalid configuration must not claim the turn' }],
  })
  assert.equal(invalidProtocolPrompt.body.result.ok, false)
  assert.equal(invalidProtocolPrompt.body.result.error.code, 'internal')
  const retriedInvalidProtocolPrompt = await rpc('session.prompt', {
    sessionId: protocolSessionId,
    mode: 'queue',
    content: [{ type: 'text', text: 'invalid configuration remains retryable' }],
  })
  assert.equal(retriedInvalidProtocolPrompt.body.result.ok, false)
  assert.equal(retriedInvalidProtocolPrompt.body.result.error.code, 'internal')
  // Promoting the queued prompt to steering folds it into the active turn
  // instead of starting the extra follow-up request exercised previously.
  assert.equal(turnRequests().length, 17)
  process.stdout.write(`dsh-edge ${runtimeMode} session integration passed\n`)
} finally {
  mock.releaseSlowResponses()
  await releasedStateSeeder?.stop()
  await worker?.stop()
  await mock.close()
  rmSync(persistedState, { recursive: true, force: true })
}

async function startReleasedStateSeeder() {
  return unstable_dev('tests/fixtures/dsh-edge-0.1.3-seed-worker.mjs', {
    config: 'wrangler.jsonc',
    env: runtimeMode === 'direct' ? '' : 'isolated',
    persistTo: persistedState,
    logLevel: 'error',
    experimental: {
      disableExperimentalWarning: true,
      showInteractiveDevSession: false,
      watch: false,
    },
  })
}

async function seedReleasedState() {
  if (releasedStateSeeder === undefined) throw new Error('Released-state seeder is not running.')
  const response = await releasedStateSeeder.fetch('http://dsh-edge.test/api/seed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sql: [
        readFileSync(new URL('./fixtures/dsh-edge-0.1.3-vfs.sql', import.meta.url), 'utf8'),
        readFileSync(new URL('./fixtures/dsh-edge-0.1.3-session.sql', import.meta.url), 'utf8'),
      ],
      entries: {
        ...JSON.parse(readFileSync(
          new URL('./fixtures/dsh-edge-0.1.3-workspace.json', import.meta.url),
          'utf8',
        )),
        // A session_projcache medium captured from the published dsh-edge 0.9.0
        // (Harness 0.1.1-rc.2) Worker by tests/fixtures/capture-released-projcache.mjs:
        // unit stamp 3 plus one bare checkpoint record. The candidate must open it
        // through the projection cache's compatibleVersions instead of rejecting
        // the boot with version-mismatch.
        ...JSON.parse(readFileSync(
          new URL('./fixtures/dsh-edge-0.9.0-projcache.json', import.meta.url),
          'utf8',
        )),
      },
    }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
}

async function startWorker(overrides = {}) {
  return unstable_dev(workerArtifactPath(runtimeMode), {
    config: runtimeConfig,
    env: runtimeMode === 'direct' ? '' : 'isolated',
    persistTo: persistedState,
    vars: {
      DEEPSEEK_API_KEY: 'integration-test-key',
      DEEPSEEK_BASE_URL: mock.url,
      DEEPSEEK_SEARCH_BASE_URL: `${mock.url}/anthropic/v1`,
      DEEPSEEK_MAX_OUTPUT_TOKENS: '16384',
      DEEPSEEK_MODEL: 'deepseek-v4-pro',
      DEEPSEEK_REASONING_EFFORT: 'high',
      DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS: '180000',
      DSH_EDGE_MAX_COMMAND_TIMEOUT_MS: '240000',
      DSH_EDGE_ACCESS_KEY: ACCESS_KEY,
      ...overrides,
    },
    logLevel: 'error',
    experimental: {
      disableExperimentalWarning: true,
      showInteractiveDevSession: false,
      watch: false,
    },
  })
}

async function turn(sessionId, message) {
  const response = await request(`/api/sessions/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
  return parseEvents(await response.text())
}

async function jsonRequest(path, init) {
  const response = await request(path, init)
  return { response, body: await response.json() }
}

function request(path, init) {
  if (worker === undefined) throw new Error('Worker is not running.')
  const headers = new Headers(init?.headers)
  if (ownerCookie !== undefined) headers.set('cookie', ownerCookie)
  return worker.fetch(`http://dsh-edge.test${path}`, { ...init, headers })
}

function assetRequest(path) {
  if (worker === undefined) throw new Error('Worker is not running.')
  const headers = ownerCookie === undefined ? undefined : { cookie: ownerCookie }
  return fetch(`http://${worker.address}:${worker.port}${path}`, { headers })
}

function loginOwner(accessKey) {
  if (worker === undefined) throw new Error('Worker is not running.')
  return fetch(`http://${worker.address}:${worker.port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ accessKey }).toString(),
    redirect: 'manual',
  })
}

async function rpc(method, payload) {
  const rpcId = crypto.randomUUID()
  const result = await jsonRequest(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method,
      payload,
    }),
  })
  assert.equal(result.body.rpcId, rpcId)
  return { ...result, rpcId }
}

async function typertRpc(namespace, method, args) {
  const rpcId = crypto.randomUUID()
  const result = await jsonRequest(`/api/${namespace}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      payload: { args },
    }),
  })
  assert.equal(result.body.rpcId, rpcId)
  return { ...result, rpcId }
}

async function openDownlink(path, cookie = ownerCookie) {
  if (worker === undefined) throw new Error('Worker is not running.')
  const socket = new WebSocket(`ws://${worker.address}:${worker.port}${path}`, {
    headers: cookie === undefined ? undefined : { cookie },
  })
  const inbox = socketInbox(socket)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  return {
    next: inbox.next,
    expectNone: inbox.expectNone,
    send: (frame) => { socket.send(JSON.stringify(frame)) },
    close: () => { socket.close(1000, 'test complete') },
  }
}

function createOwnerSessionCookie(lifetimeSeconds) {
  const expiresAt = Math.floor(Date.now() / 1_000) + lifetimeSeconds
  const signature = createHmac('sha256', ACCESS_KEY)
    .update(`dsh-edge-owner-session\0${String(expiresAt)}`)
    .digest('base64url')
  return `dsh_edge_owner=v1.${String(expiresAt)}.${signature}`
}

function rejectedDownlinkStatus(path, headers) {
  if (worker === undefined) throw new Error('Worker is not running.')
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${worker.address}:${worker.port}${path}`, { headers })
    socket.once('unexpected-response', (_request, response) => {
      const statusCode = response.statusCode
      const settle = () => { resolve(statusCode) }
      const settleNetworkError = (error) => {
        if (error?.code === 'ECONNRESET') {
          settle()
          return
        }
        reject(error)
      }
      response.once('end', settle)
      response.once('aborted', settle)
      response.once('error', settleNetworkError)
      // Windows can reset a rejected upgrade after delivering its HTTP status.
      // Keep ownership of the raw socket until that rejection has settled.
      response.socket.once('error', settleNetworkError)
      response.resume()
    })
    socket.once('open', () => {
      socket.close(1000, 'unexpected authenticated connection')
      reject(new Error('Unauthenticated WebSocket unexpectedly opened.'))
    })
    socket.once('error', reject)
  })
}

function socketInbox(socket) {
  const messages = []
  const waiters = new Set()
  socket.addEventListener('message', (event) => {
    messages.push(JSON.parse(event.data))
    for (const wake of waiters) wake()
    waiters.clear()
  })
  return {
    async next(predicate) {
      const deadline = Date.now() + 5_000
      while (true) {
        const index = messages.findIndex(predicate)
        if (index !== -1) return messages.splice(index, 1)[0]
        if (Date.now() >= deadline) throw new Error('Timed out waiting for a WebSocket frame.')
        await new Promise(resolve => {
          const timer = setTimeout(() => {
            waiters.delete(wake)
            resolve()
          }, 25)
          const wake = () => {
            clearTimeout(timer)
            resolve()
          }
          waiters.add(wake)
        })
      }
    },
    async expectNone(predicate, durationMs = 250) {
      const deadline = Date.now() + durationMs
      while (Date.now() < deadline) {
        const duplicate = messages.find(predicate)
        if (duplicate !== undefined) {
          throw new Error(`Unexpected duplicate WebSocket frame: ${JSON.stringify(duplicate)}`)
        }
        await new Promise(resolve => {
          const timer = setTimeout(() => {
            waiters.delete(wake)
            resolve()
          }, Math.min(25, Math.max(0, deadline - Date.now())))
          const wake = () => {
            clearTimeout(timer)
            resolve()
          }
          waiters.add(wake)
        })
      }
    },
  }
}

function parseEvents(source) {
  return source.split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice('data: '.length)))
}

function assistantText(events) {
  const event = [...events].reverse().find(candidate => candidate.type === 'assistant/message')
  return event?.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function toolResultText(event) {
  return event?.data.message.content
    .find(block => block.type === 'tool-result')?.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the mock request.')
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
}
