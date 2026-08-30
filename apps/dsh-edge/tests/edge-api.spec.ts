import type {
  PromptContentPart,
  RpcRequest,
  WorkspaceId,
  WorkspaceView,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  AttachmentId,
  type AttachmentStore,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import { RpcId, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createUserMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_MESSAGE_TEXT_BYTES,
  attachPublishedSession,
  createEdgeApi,
  messageTextByteLength,
  type EdgeApiRuntime,
} from '../src/edge-api.ts'
import {
  EDGE_HISTORY_PAGE_LIMITS,
  type EdgeEventPage,
} from '../src/do-session-persistence.ts'
import {
  findInEventPages,
  paginateHistory,
  searchSnippet,
  type EdgeApiSessionSummary,
} from '../src/session-store.ts'

const workspaceId = 'edge-workspace' as WorkspaceId
const parentId = SessionId('session-parent')
const childId = SessionId('session-child')
const imageLimits: ImageAttachmentLimits = {
  maxImageBytes: 3_670_016,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 7_340_032,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2_000,
  mediaTypes: ['image/png', 'image/jpeg'],
}
const imageRef: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
  name: 'pixel.png',
}

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(crypto.randomUUID()), payload }
}

function summary(
  id: ReturnType<typeof SessionId>,
  overrides: Partial<EdgeApiSessionSummary> = {},
): EdgeApiSessionSummary {
  return {
    id,
    title: null,
    createdAt: 1,
    lastPromptAt: null,
    updatedAt: 1,
    lastSeq: -1,
    blank: true,
    cwd: '/workspace',
    agentPreset: 'dsh-edge',
    ...overrides,
  }
}

function historyMessage(seq: number, text = `prompt ${String(seq)}`): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: seq,
    data: createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  }
}

function runtime(
  sessions: Record<string, unknown>,
  overrides: Partial<EdgeApiRuntime> = {},
): EdgeApiRuntime {
  const workspace: WorkspaceView = {
    workspaceId,
    path: '/workspace',
    title: 'workspace',
    sessionIds: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
  return {
    sessions: {
      modelCatalog: vi.fn(async () => ({
        groups: [{
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [
            { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
            { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
            { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp' },
          ],
        }],
        failures: [],
      })),
      projectionSnapshot: vi.fn(() => undefined),
      projectionCachedSnapshot: vi.fn(() => undefined),
      ...sessions,
    } as unknown as EdgeApiRuntime['sessions'],
    model: 'deepseek-test',
    version: 'test',
    deploymentProfile: () => ({
      shell: 'just-bash-direct',
      storage: 'durable-object-sqlite-vfs',
      attachmentStorage: 'temporary-do',
      deploymentId: 'test-deployment',
      apiKeyConfigured: true,
      baseURL: 'https://api.deepseek.test',
      maxTokens: 4_096,
      model: 'deepseek-test',
      reasoningEffort: 'low',
      searchBaseURL: 'https://api.deepseek.test/anthropic/v1',
      streamIdleTimeoutMs: 30_000,
      commandTimeoutPolicy: {
        defaultTimeoutMs: 10_000,
        maxTimeoutMs: 20_000,
      },
    }),
    describeCredential: vi.fn(async ref => ref === 'DEEPSEEK_API_KEY'
      ? { configured: true, source: 'worker-secret', writable: true }
      : { configured: false, writable: true }),
    setCredential: vi.fn(async () => {}),
    unsetCredential: vi.fn(async () => {}),
    settingsWritable: vi.fn(async () => true),
    settingsHasDocument: vi.fn(async () => false),
    describeSettings: vi.fn(async () => []),
    updateSettings: vi.fn(async () => undefined),
    replaceSettings: vi.fn(async () => undefined),
    mutateSettings: vi.fn(async () => undefined),
    listConfigurableProviders: vi.fn(async () => []),
    listLlmProviders: vi.fn(async () => [{ id: 'deepseek-official', name: 'DeepSeek' }]),
    isRunning: () => false,
    prompt: vi.fn(async () => {}),
    updateQueue: vi.fn(() => 'accepted' as const),
    cancel: () => false,
    workspaceList: vi.fn(async () => ({ items: [workspace], archivedSessionIds: [] })),
    workspaceCreate: vi.fn(async () => ({ workspace, created: true })),
    workspaceRename: vi.fn(async () => workspace),
    workspaceDelete: vi.fn(async () => {}),
    workspaceInsertBefore: vi.fn(async () => [workspaceId]),
    workspaceInsertSessionBefore: vi.fn(async () => workspace),
    archiveSession: vi.fn(async () => []),
    sessionCreated: vi.fn(),
    sessionAttached: vi.fn(async () => {}),
    workspaceForSession: vi.fn(async () => workspaceId),
    sessionEvent: vi.fn(),
    ...overrides,
  }
}

describe('Edge upstream API invariants', () => {
  it('projects the programmatic Edge composition through the upstream preset viewer', async () => {
    const edge = runtime({})
    const api = createEdgeApi(edge)

    const response = await api.agentPresets.read(request({ agentPreset: 'dsh-edge' }))

    expect(response.result).toMatchObject({
      ok: true,
      value: {
        agentPreset: 'dsh-edge',
        trust: 'system',
        name: 'DSH Edge',
      },
    })
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.content).toContain('# Effective dsh-edge composition (read-only)')
    expect(response.result.value.content).toContain('shell: "just-bash-direct"')
    expect(response.result.value.content).toContain('defaultId: "deepseek-test"')
    expect(response.result.value.content).toContain('selectionScope: session')
    expect(response.result.value.content).toContain('id: "deepseek-v4-pro"')
    expect(response.result.value.content).toContain('id: "deepseek-v4-flash-vision-exp"')
    expect(response.result.value.content).toContain('configured: true')
    expect(response.result.value.content).toContain('deploymentId: "test-deployment"')
    expect(response.result.value.content).not.toContain('apiKey:')

    const missing = await api.agentPresets.read(request({ agentPreset: 'missing' }))
    expect(missing.result).toMatchObject({
      ok: false,
      error: { code: 'agent-preset-not-found' },
    })

    const invalidProfile = await createEdgeApi(runtime({}, {
      deploymentProfile: () => { throw new Error('invalid deployment profile') },
    })).agentPresets.read(request({ agentPreset: 'dsh-edge' }))
    expect(invalidProfile.result).toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'invalid deployment profile' },
    })
  })

  it('describes only the configured state of the deployment credential', async () => {
    const configured = await createEdgeApi(runtime({})).credentials.describe(request({
      refs: ['DEEPSEEK_API_KEY', 'OTHER_KEY'],
    }))
    expect(configured.result).toEqual({
      ok: true,
      value: {
        credentials: {
          DEEPSEEK_API_KEY: { configured: true, source: 'worker-secret', writable: true },
          OTHER_KEY: { configured: false, writable: true },
        },
      },
    })

    const unconfigured = await createEdgeApi(runtime({}, {
      describeCredential: vi.fn(async () => ({ configured: false, writable: true })),
    })).credentials.describe(request({ refs: ['DEEPSEEK_API_KEY'] }))
    expect(unconfigured.result).toEqual({
      ok: true,
      value: {
        credentials: {
          DEEPSEEK_API_KEY: { configured: false, writable: true },
        },
      },
    })
  })

  it('projects the upstream DeepSeek catalog and applies a session-local model selection', async () => {
    const modelCatalog = vi.fn(async () => ({
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
          { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp' },
        ],
      }],
      failures: [],
    }))
    const modelSelection = vi.fn(async () => ({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    }))
    const selectModel = vi.fn(async () => ({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      reasoningEffort: 'high',
    }))
    const api = createEdgeApi(runtime({ modelCatalog, modelSelection, selectModel }))

    const current = await api.sessions.models(request({ sessionId: parentId }))
    expect(current.result).toMatchObject({
      ok: true,
      value: {
        current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        groups: [{ models: [
          { id: 'deepseek-v4-flash' },
          { id: 'deepseek-v4-pro' },
          { id: 'deepseek-v4-flash-vision-exp' },
        ] }],
      },
    })
    expect(modelSelection).toHaveBeenCalledWith(parentId, 'deepseek-test')

    const selected = await api.sessions.selectModel(request({
      sessionId: parentId,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      reasoningEffort: 'high',
    }))
    expect(selected.result).toEqual({
      ok: true,
      value: {
        selected: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash-vision-exp',
          reasoningEffort: 'high',
        },
      },
    })
    expect(selectModel).toHaveBeenCalledWith(parentId, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      reasoningEffort: 'high',
    })

    const global = await api.llm.models(request({}))
    expect(global.result).toMatchObject({ ok: true, value: { groups: [{ id: 'deepseek-official' }] } })
    expect(modelCatalog).toHaveBeenCalledTimes(2)
  })

  it('serves bounded content search and preserves cancellation', async () => {
    const searchApiSessions = vi.fn(async (_query: string, _signal?: AbortSignal) => ({
      items: [{ sessionId: parentId, snippet: 'matching current message' }],
      hasMore: false,
    }))
    const edge = runtime({ searchApiSessions })
    const controller = new AbortController()

    const response = await createEdgeApi(edge).sessions.search(request({ query: 'current' }), controller.signal)
    expect(response.result).toEqual({
      ok: true,
      value: {
        items: [{ sessionId: parentId, snippet: 'matching current message' }],
        hasMore: false,
      },
    })
    expect(searchApiSessions).toHaveBeenCalledWith('current', controller.signal)

    controller.abort()
    searchApiSessions.mockImplementationOnce(async (_query: string, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      return { items: [], hasMore: false }
    })
    const cancelled = await createEdgeApi(edge).sessions.search(
      request({ query: 'cancelled' }),
      controller.signal,
    )
    expect(cancelled.result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('bounds a multibyte search excerpt around the literal match', () => {
    const snippet = searchSnippet(
      `${'前'.repeat(SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS)} NEEDLE ${'后'.repeat(SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS)}`,
      'needle',
      SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
    )
    expect(Array.from(snippet)).toHaveLength(SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS)
    expect(snippet).toContain('NEEDLE')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('keeps excerpt offsets on the whitespace-collapsed search surface', () => {
    const snippet = searchSnippet(
      `${'prefix'.repeat(20)}${' '.repeat(500)}NEEDLE ${'suffix'.repeat(20)}`,
      'needle',
      48,
    )
    expect(Array.from(snippet)).toHaveLength(48)
    expect(snippet).toContain('NEEDLE')
    expect(snippet).not.toContain('  ')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('maps length-changing Unicode case folds back to source code points', () => {
    const snippet = searchSnippet(
      `${'İ'.repeat(80)} NEEDLE ${'suffix'.repeat(20)}`,
      'needle',
      48,
    )
    expect(Array.from(snippet)).toHaveLength(48)
    expect(snippet).toContain('NEEDLE')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('applies one message, event, and byte budget to live history pages', () => {
    const page = paginateHistory(
      Array.from({ length: 60 }, (_, seq) => historyMessage(seq)),
      undefined,
      Number.MAX_SAFE_INTEGER,
    )
    expect(page.events).toMatchObject(
      Array.from({ length: EDGE_HISTORY_PAGE_LIMITS.maxMessages }, (_, index) => ({
        type: 'user/message',
        seq: index + 10,
      })),
    )
    expect(page.hasMore).toBe(true)

    const eventHeavy = [
      ...Array.from({ length: EDGE_HISTORY_PAGE_LIMITS.maxEvents }, (_, seq): SessionEvent => ({
        type: 'session/title',
        seq,
        time: seq,
        data: { title: `title ${String(seq)}`, messageSeqs: [], source: { kind: 'user' } },
      })),
      { ...historyMessage(EDGE_HISTORY_PAGE_LIMITS.maxEvents), sourceEventSeqs: [0] },
    ]
    expect(() => paginateHistory(eventHeavy, undefined, 1)).toThrow(/65536 events/)
    expect(() => paginateHistory([
      historyMessage(0, 'x'.repeat(EDGE_HISTORY_PAGE_LIMITS.maxStoredBytes)),
    ], undefined, 1)).toThrow(/encoded bytes/)
  })

  it('keeps every post-publication Workspace failure recoverable by Session id', async () => {
    const error = await attachPublishedSession(
      parentId,
      workspaceId,
      'created',
      async () => { throw new Error('simulated storage failure') },
    )
    expect(error).toMatchObject({
      code: 'workspace-attach-failed',
      details: { sessionId: parentId, workspaceId },
    })
  })

  it('returns the published id when session creation cannot attach its Workspace', async () => {
    const created = summary(parentId)
    const sessionCreated = vi.fn()
    const edge = runtime({
      listApiSessions: vi.fn(async () => [created]),
      createBlankSession: vi.fn(async () => ({
        sessionId: parentId,
        agentPreset: 'dsh-edge',
        created: true,
      })),
    }, {
      sessionCreated,
      sessionAttached: vi.fn(async () => { throw new Error('simulated attach failure') }),
    })

    const response = await createEdgeApi(edge).sessions.create(request({
      workspaceId,
      sessionId: parentId,
    }))

    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: 'workspace-attach-failed',
        details: { sessionId: parentId, workspaceId },
      },
    })
    expect(sessionCreated).toHaveBeenCalledWith(created)
  })

  it('resolves the source Workspace before publishing a fork and reports attach partial success', async () => {
    const child = summary(childId, { parentSessionId: parentId, blank: false })
    const forkSession = vi.fn(async () => child)
    const lookupSessionCreated = vi.fn()
    const lookupFailure = runtime({ forkSession }, {
      sessionCreated: lookupSessionCreated,
      workspaceForSession: vi.fn(async () => { throw new Error('lookup failed') }),
    })

    const refused = await createEdgeApi(lookupFailure).sessions.fork(request({
      sessionId: parentId,
    }))
    expect(refused.result).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(forkSession).not.toHaveBeenCalled()
    expect(lookupSessionCreated).not.toHaveBeenCalled()

    const attachSessionCreated = vi.fn()
    const attachFailure = runtime({ forkSession }, {
      sessionCreated: attachSessionCreated,
      sessionAttached: vi.fn(async () => { throw new Error('attach failed') }),
    })
    const published = await createEdgeApi(attachFailure).sessions.fork(request({
      sessionId: parentId,
    }))
    expect(published.result).toMatchObject({
      ok: false,
      error: {
        code: 'workspace-attach-failed',
        details: { sessionId: childId, workspaceId },
      },
    })
    expect(attachSessionCreated).toHaveBeenCalledWith(child)
  })

  it('publishes renamed sessions only when no active turn observer owns delivery', async () => {
    const activeEvent: SessionEvent<'session/title'> = {
      type: 'session/title',
      seq: 4,
      time: 1,
      data: {
        title: 'Active',
        messageSeqs: [],
        source: { kind: 'user' },
      },
    }
    const idleEvent: SessionEvent<'session/title'> = {
      ...activeEvent,
      seq: 5,
      data: { ...activeEvent.data, title: 'Idle' },
    }
    const sessionEvent = vi.fn()
    const renameSession = vi.fn()
      .mockResolvedValueOnce({ title: 'Active', event: activeEvent, publishRequired: false })
      .mockResolvedValueOnce({ title: 'Idle', event: idleEvent, publishRequired: true })
    const edge = runtime({ renameSession }, { sessionEvent })

    const active = await createEdgeApi(edge).sessions.rename(request({
      sessionId: parentId,
      title: 'Active',
    }))
    expect(active.result).toMatchObject({ ok: true, value: { title: 'Active', seq: 4 } })
    expect(sessionEvent).not.toHaveBeenCalled()

    const idle = await createEdgeApi(edge).sessions.rename(request({
      sessionId: parentId,
      title: 'Idle',
    }))
    expect(idle.result).toMatchObject({ ok: true, value: { title: 'Idle', seq: 5 } })
    expect(sessionEvent).toHaveBeenCalledOnce()
    expect(sessionEvent).toHaveBeenCalledWith(parentId, idleEvent)
  })

  it('shares one UTF-8 text limit across prompts and queue edits', async () => {
    const updateQueue = vi.fn(() => 'accepted' as const)
    const prompt = vi.fn(async () => {})
    const edge = runtime({}, { updateQueue, prompt })
    const exact = [
      { type: 'text', text: 'x'.repeat(MAX_MESSAGE_TEXT_BYTES) },
    ] satisfies PromptContentPart[]
    const oversized = [{ type: 'text', text: '界'.repeat(21_846) }] satisfies PromptContentPart[]
    expect(messageTextByteLength(exact)).toBe(MAX_MESSAGE_TEXT_BYTES)
    expect(messageTextByteLength(oversized)).toBeGreaterThan(MAX_MESSAGE_TEXT_BYTES)

    const exactPrompt = await createEdgeApi(edge).sessions.prompt(request({
      sessionId: parentId,
      mode: 'queue' as const,
      content: exact,
    }))
    expect(exactPrompt.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(prompt).toHaveBeenCalledOnce()
    prompt.mockClear()

    const exactEdit = await createEdgeApi(edge).sessions.updateQueue(request({
      sessionId: parentId,
      itemId: 'message-exact' as MessageId,
      action: { kind: 'edit' as const, content: exact },
    }))
    expect(exactEdit.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(updateQueue).toHaveBeenCalledOnce()
    updateQueue.mockClear()

    const promptResponse = await createEdgeApi(edge).sessions.prompt(request({
      sessionId: parentId,
      mode: 'queue' as const,
      content: oversized,
    }))
    expect(promptResponse.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'PROMPT_TEXT_TOO_LARGE' } },
    })
    expect(prompt).not.toHaveBeenCalled()

    const editResponse = await createEdgeApi(edge).sessions.updateQueue(request({
      sessionId: parentId,
      itemId: 'message-queued' as MessageId,
      action: { kind: 'edit' as const, content: oversized },
    }))
    expect(editResponse.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'QUEUE_EDIT_TEXT_TOO_LARGE' } },
    })
    expect(updateQueue).not.toHaveBeenCalled()
  })

  it('lets the runtime authorize already-admitted images in queue edits', async () => {
    const updateQueue = vi.fn()
      .mockReturnValueOnce('accepted')
      .mockReturnValueOnce('queue-edit-attachment-invalid')
    const api = createEdgeApi(runtime({}, { updateQueue }))
    const action = {
      kind: 'edit' as const,
      content: [
        { type: 'text' as const, text: 'edited caption' },
        { type: 'image' as const, attachment: imageRef },
      ],
    }

    const accepted = await api.sessions.updateQueue(request({
      sessionId: parentId,
      itemId: 'message-image' as MessageId,
      action,
    }))
    expect(accepted.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(updateQueue).toHaveBeenNthCalledWith(1, parentId, 'message-image', action)

    const rejected = await api.sessions.updateQueue(request({
      sessionId: parentId,
      itemId: 'message-image' as MessageId,
      action,
    }))
    expect(rejected.result).toMatchObject({
      ok: false,
      error: {
        code: 'attachment-error',
        details: { reason: 'QUEUE_EDIT_ATTACHMENT_INVALID' },
      },
    })
  })

  it('uses upstream image admission and durable refs without changing the prompt wire', async () => {
    const saveImages = vi.fn(async () => [imageRef])
    const attachmentStore = vi.fn(async () => ({ saveImages } as unknown as AttachmentStore))
    const modelSupportsImages = vi.fn(async () => true)
    const prompt = vi.fn(async () => {})
    const edge = runtime({ attachmentStore, modelSupportsImages }, {
      imageLimits,
      prompt,
    })

    const response = await createEdgeApi(edge).sessions.prompt(request({
      sessionId: parentId,
      mode: 'queue' as const,
      content: [
        { type: 'text' as const, text: 'describe this' },
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQID', name: 'pixel.png' },
      ],
    }))

    expect(response.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(saveImages).toHaveBeenCalledWith([{
      data: Uint8Array.of(1, 2, 3),
      mediaType: 'image/png',
      name: 'pixel.png',
    }])
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: parentId,
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image', attachment: imageRef },
      ],
    }))
  })

  it('preflights model modality before publishing image bytes', async () => {
    const saveImages = vi.fn(async () => [imageRef])
    const prompt = vi.fn(async () => {})
    const edge = runtime({
      attachmentStore: vi.fn(async () => ({ saveImages } as unknown as AttachmentStore)),
      modelSupportsImages: vi.fn(async () => false),
    }, { imageLimits, prompt })

    const response = await createEdgeApi(edge).sessions.prompt(request({
      sessionId: parentId,
      mode: 'queue' as const,
      content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'AQID' }],
    }))

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } },
    })
    expect(saveImages).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
  })

  it('keeps model selection behind an in-flight image admission', async () => {
    const saveStarted = Promise.withResolvers<void>()
    const releaseSave = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    const saveImages = vi.fn(async () => {
      saveStarted.resolve()
      return await releaseSave.promise
    })
    const prompt = vi.fn(async () => {})
    const selectModel = vi.fn(async () => ({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    }))
    const api = createEdgeApi(runtime({
      attachmentStore: vi.fn(async () => ({ saveImages } as unknown as AttachmentStore)),
      modelSupportsImages: vi.fn(async () => true),
      selectModel,
    }, { imageLimits, prompt }))

    const admitting = api.sessions.prompt(request({
      sessionId: parentId,
      mode: 'queue' as const,
      content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'AQID' }],
    }))
    await saveStarted.promise
    const selecting = api.sessions.selectModel(request({
      sessionId: parentId,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    }))
    await Promise.resolve()

    expect(selectModel).not.toHaveBeenCalled()
    releaseSave.resolve([imageRef])
    await expect(admitting).resolves.toMatchObject({ result: { ok: true } })
    await expect(selecting).resolves.toMatchObject({ result: { ok: true } })
    expect(prompt).toHaveBeenCalledBefore(selectModel)
  })

  it('rechecks image modality after an earlier model selection completes', async () => {
    const selectionStarted = Promise.withResolvers<void>()
    const releaseSelection = Promise.withResolvers<void>()
    const selectModel = vi.fn(async () => {
      selectionStarted.resolve()
      await releaseSelection.promise
      return { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    })
    const modelSupportsImages = vi.fn(async () => false)
    const saveImages = vi.fn(async () => [imageRef])
    const api = createEdgeApi(runtime({
      attachmentStore: vi.fn(async () => ({ saveImages } as unknown as AttachmentStore)),
      modelSupportsImages,
      selectModel,
    }, { imageLimits }))

    const selecting = api.sessions.selectModel(request({
      sessionId: parentId,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    }))
    await selectionStarted.promise
    const admitting = api.sessions.prompt(request({
      sessionId: parentId,
      mode: 'queue' as const,
      content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'AQID' }],
    }))
    await Promise.resolve()

    expect(modelSupportsImages).not.toHaveBeenCalled()
    releaseSelection.resolve()
    await expect(selecting).resolves.toMatchObject({ result: { ok: true } })
    await expect(admitting).resolves.toMatchObject({
      result: {
        ok: false,
        error: { code: 'attachment-error', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } },
      },
    })
    expect(saveImages).not.toHaveBeenCalled()
  })

  it('authorizes attachment reads through canonical session references', async () => {
    const readImage = vi.fn(async () => ({ ref: imageRef, data: Uint8Array.of(1, 2, 3) }))
    const referencedImage = vi.fn(async () => imageRef)
    const edge = runtime({
      attachmentStore: vi.fn(async () => ({ readImage } as unknown as AttachmentStore)),
      referencedImage,
    }, { imageLimits })

    const response = await createEdgeApi(edge).sessions.attachment(request({
      sessionId: parentId,
      attachmentId: imageRef.attachmentId,
    }))

    expect(response.result).toMatchObject({
      ok: true,
      value: { attachment: imageRef, data: 'AQID' },
    })
    expect(referencedImage).toHaveBeenCalledWith(parentId, String(imageRef.attachmentId))
  })

  it('finds an authorized image after a bounded cold-history page', async () => {
    const prefix = Array.from({ length: EDGE_HISTORY_PAGE_LIMITS.maxEvents }, (_, seq) => (
      historyMessage(seq)
    ))
    const imageEvent: SessionEvent = {
      type: 'user/message',
      seq: EDGE_HISTORY_PAGE_LIMITS.maxEvents,
      time: EDGE_HISTORY_PAGE_LIMITS.maxEvents,
      data: createUserMessage({
        content: [{ type: 'image', attachment: imageRef }],
        source: { kind: 'user' },
      }),
      surfaceOp: 'append',
    }
    const page = (events: SessionEvent[], hasMore: boolean): EdgeEventPage => ({
      meta: { id: parentId, version: 0, createdAt: 1 },
      events,
      hasMore,
    })
    const readPage = vi.fn(async (fromSeq: number) => fromSeq === 0
      ? page(prefix, true)
      : page([imageEvent], false))

    await expect(findInEventPages(
      readPage,
      events => events.includes(imageEvent) ? imageRef : undefined,
      parentId,
    )).resolves.toEqual(imageRef)
    expect(readPage).toHaveBeenNthCalledWith(1, 0)
    expect(readPage).toHaveBeenNthCalledWith(2, EDGE_HISTORY_PAGE_LIMITS.maxEvents)
  })

  it('finishes a bounded multi-page full-history predicate when no page matches', async () => {
    const page = (events: SessionEvent[], hasMore: boolean): EdgeEventPage => ({
      meta: { id: parentId, version: 0, createdAt: 1 },
      events,
      hasMore,
    })
    const readPage = vi.fn(async (fromSeq: number) => fromSeq === 0
      ? page([historyMessage(0)], true)
      : page([historyMessage(1)], false))

    await expect(findInEventPages(
      readPage,
      () => undefined,
      parentId,
    )).resolves.toBeUndefined()
    expect(readPage).toHaveBeenNthCalledWith(1, 0)
    expect(readPage).toHaveBeenNthCalledWith(2, 1)
  })

  it('rejects a cold-history page that cannot make bounded progress', async () => {
    const readPage = vi.fn(async (): Promise<EdgeEventPage> => ({
      meta: { id: parentId, version: 0, createdAt: 1 },
      events: [],
      hasMore: true,
    }))

    await expect(findInEventPages(
      readPage,
      () => undefined,
      parentId,
    )).rejects.toMatchObject({ code: 'INVALID_DATA' })
    expect(readPage).toHaveBeenCalledOnce()
  })

  it('projects image limits only when an attachment backend is composed', async () => {
    const sessions = { listApiSessions: vi.fn(async () => [summary(parentId)]) }
    const enabled = await createEdgeApi(runtime(sessions, { imageLimits })).sessions.list(request({}))
    const disabled = await createEdgeApi(runtime(sessions)).sessions.list(request({}))

    expect(enabled.result).toMatchObject({
      ok: true,
      value: { items: [{ projections: { values: { imageLimits } } }] },
    })
    expect(disabled.result).toMatchObject({ ok: true })
    if (disabled.result.ok) {
      const values = disabled.result.value.items[0]?.projections?.values
      expect(values).toHaveProperty('sessionListMetadata')
      expect(values).not.toHaveProperty('imageLimits')
    }
  })
})
