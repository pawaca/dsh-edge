/** Canonical DSH sessions backed by the upstream persistence service. */

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { DurableObjectStorageBackend } from './do-storage-backend.ts'
import AgentRegistry, {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type {
  AttachmentStore,
  ImageAttachmentLimits,
  ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import { credentialRef, type CredentialInfo } from '@deepseek-ai/dsh-credentials'
import LlmRuntime, { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
  type ModelCatalogFailure,
  type ModelProviderGroup,
  type ModelReasoning,
  type QueuedInboxItem,
  type RpcId,
  type SessionSearchItem,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import SessionStore, {
  SessionId,
  isAppendSurfaceEvent,
  type SessionEvent,
  type SessionEventMap,
  type SessionHeader,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { buildSessionEventSearchDocuments } from '@deepseek-ai/dsh-session-query'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  foldSessionTitle,
  normalizeSessionTitle,
} from '@deepseek-ai/dsh-session-title'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as FirstPromptTitle from '@deepseek-ai/dsh-session-title-first-prompt-llm'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import GoalService from '@deepseek-ai/dsh-goal'
import { EdgeFileSystem } from './edge-filesystem.ts'
import {
  EDGE_SYSTEM_PROMPT,
  EdgeShellBindings,
  createEdgeBashTool,
  type EdgeShell,
} from './agent.ts'
import * as dshLlmDeepseek from '@deepseek-ai/dsh-llm-deepseek'
import { DeepSeekFileStore } from '@deepseek-ai/dsh-llm-deepseek'
import { DurableObjectUploadIndex } from './do-upload-index.ts'
import {
  EdgeDoAttachmentStore,
  EdgeR2AttachmentStore,
  type EdgeAttachmentStorage,
} from './edge-attachment-store.ts'
import { EdgeVfsSpillStore } from './edge-spill-store.ts'
import {
  settingsNamespace,
  type SettingsDescriptor,
  type SettingsPathOp,
} from '@deepseek-ai/dsh-settings'
import DurableObjectSettingsProvider from './do-settings-provider.ts'
import EdgeCredentialProvider from './edge-credentials.ts'
import DurableObjectSessionPersistence, {
  EDGE_HISTORY_PAGE_LIMITS,
  type EdgeEventPage,
} from './do-session-persistence.ts'
import EdgeModelSelectionBridge from './model-selection-bridge.ts'
import type { CreateEdgeSessionInput, EdgeSession } from './protocol.ts'
import { installEdgeWebSearch } from './web-search.ts'

const MAX_TITLE_BYTES = 640
const MAX_FORK_EVENTS = 8_192

interface EdgeSessionStoreConfig {
  readDeepSeekApiKey(): string | undefined
  searchBaseURL?: string
  attachmentStorage: EdgeAttachmentStorage
  attachmentBucket?: R2Bucket
  images?: unknown
  baseURL?: string
  maxTokens?: string
  reasoningEffort?: string
  streamIdleTimeoutMs?: string
  onLateSessionEvent?: (sessionId: SessionId, event: SessionEvent) => void
  waitUntil?: (promise: Promise<unknown>) => void
}
const MAX_FORK_STORED_BYTES = 8 * 1_024 * 1_024
const MAX_SEARCH_SESSIONS = 32
const MAX_SEARCH_EVENTS_PER_SESSION = 512
const MAX_SEARCH_STORED_BYTES_PER_SESSION = 256 * 1_024
const EDGE_PROVIDER = 'deepseek-official'
const DEFAULT_EDGE_MODEL = 'deepseek-v4-flash'
const MESSAGE_TYPES = new Set<SessionEvent['type']>(['user/message', 'assistant/message'])

export interface EdgeSessionListPage {
  sessions: EdgeSession[]
  hasMore: boolean
  nextAfter?: SessionId
}

function requireAttachmentBucket(bucket: R2Bucket | undefined): R2Bucket {
  if (bucket === undefined) throw new Error('The private R2 attachment binding is unavailable.')
  return bucket
}

/** Upstream session-list and subscription metadata derived from live or stored sessions. */
export interface EdgeApiSessionSummary {
  id: SessionId
  title: string | null
  createdAt: number
  lastPromptAt: number | null
  updatedAt: number
  lastSeq: number
  blank: boolean
  parentSessionId?: SessionId
  origin?: 'subagent'
  cwd?: string
  agentPreset?: string
}

export interface EdgeSessionHistoryPage {
  summary: EdgeApiSessionSummary
  events: SessionEvent[]
  hasMore: boolean
}

export interface EdgeSessionSearchPage {
  items: SessionSearchItem[]
  hasMore: boolean
}

export interface EdgeMuxBaseline {
  sessions: EdgeApiSessionSummary[]
  queues: { sessionId: SessionId; items: QueuedInboxItem[] }[]
}

export interface EdgeAgentPromptAdmission {
  mode: 'queue' | 'steer'
  content: ContentBlock[]
  rpcId?: RpcId
  clientTimeZone?: string
}

export type EdgeAgentPromptAdmitter = (input: EdgeAgentPromptAdmission) => Promise<void>

export class EdgeSessionStoreError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'BUSY' | 'INVALID_DATA' | 'TITLE_INVALID' | 'FORK_UNAVAILABLE',
    message: string,
  ) {
    super(message)
  }
}

export class EdgeSessionCwdConflictError extends Error {
  constructor(
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super('Session cwd conflicts with existing session.')
  }
}

/**
 * Edge-facing facade over the same SessionStore + SessionPersistence services
 * used by upstream. Durable Object SQL is visible only to the backend plugin.
 */
export class EdgeSessionStore {
  private readonly context = new Context()
  private readonly shells = new EdgeShellBindings()
  private readonly blankHandles = new Map<SessionId, AgentHandle>()
  private readonly modelSelections: EdgeModelSelectionBridge
  private readonly turnPublishedAgents = new WeakSet<Agent>()
  private readonly ready: Promise<void>

  constructor(
    storage: DurableObjectStorage,
    config: EdgeSessionStoreConfig,
  ) {
    this.modelSelections = new EdgeModelSelectionBridge(storage)
    this.ready = this.initialize(storage, config)
  }

  private async initialize(
    storage: DurableObjectStorage,
    config: EdgeSessionStoreConfig,
  ): Promise<void> {
    const images = config.images as import('./edge-attachment-store.ts').ImagesBinding | undefined
    await (config.attachmentStorage === 'temporary-do'
      ? this.context.plugin(EdgeDoAttachmentStore, { storage, ...(images !== undefined ? { images } : {}) })
      : this.context.plugin(EdgeR2AttachmentStore, {
          bucket: requireAttachmentBucket(config.attachmentBucket),
          ...(images !== undefined ? { images } : {}),
        }))
    await this.context.plugin(EdgeCredentialProvider, {
      storage,
      readDeepSeekApiKey: () => config.readDeepSeekApiKey(),
    })
    await this.context.plugin(DurableObjectSettingsProvider, { storage })
    await DurableObjectStorageBackend.migrateWorkspaceKeys(storage)
    await DurableObjectStorageBackend.repairEpoch0Timestamps(storage)
    const storageBackend = new DurableObjectStorageBackend(storage)
    await this.context.plugin(Storage)
    this.context.effect(() => {
      const dispose = this.context.storage.backend.register('durable-object', storageBackend)
      this.context.provide('storage.backend.durable-object', true)
      return () => { dispose(); this.context.provide('storage.backend.durable-object', undefined as never) }
    }, 'dsh-edge: storage backend')
    await this.context.plugin(StorageDomain, { backend: 'durable-object' })
    const onboardingSchema = Object.assign(
      (value: unknown) => value ?? {},
      { toJSON: () => ({ type: 'object' }) },
    ) as never
    this.context.settings.register(settingsNamespace('ui-onboarding'), onboardingSchema, {})
    await this.context.plugin(LlmRuntime)
    try {
      const doUploadIndex = new DurableObjectUploadIndex(storage)
      ;(this.context as never as Record<string, unknown>)['edgeFileStore'] = new DeepSeekFileStore({ index: doUploadIndex as never })
      await this.context.plugin(dshLlmDeepseek, buildEdgeLlmPluginConfig(config))
    } catch (error) {
      console.error('dsh-edge: LLM provider plugin failed to initialize; model operations will be unavailable.', error)
    }
    await this.context.plugin(SessionStore)
    await this.context.plugin(SessionProjectionRegistry)
    await this.context.plugin(TokenMeter)
    await this.context.plugin(BasicCompactionEngine)
    await this.context.plugin(ToolResultPruner)
    await this.context.plugin(SessionTitleService, {
      fallbackMaxWords: 8,
      fallbackMaxBytes: MAX_TITLE_BYTES,
      maxTitleBytes: MAX_TITLE_BYTES,
    })
    await this.context.plugin(FirstPromptTitle, {
      targetWords: 6,
      targetCjkCharacters: 12,
      maxInputBytes: 4096,
      maxOutputTokens: 32,
      timeoutMs: 10_000,
      provider: EDGE_PROVIDER,
      model: DEFAULT_EDGE_MODEL,
    })
    await this.context.plugin(SystemPrompt, { persona: EDGE_SYSTEM_PROMPT })
    await this.context.plugin(EdgeVfsSpillStore)
    await this.context.plugin(EdgeFileSystem)
    await this.context.plugin(ToolRuntime)
    await this.context.plugin(ToolFs)
    await this.context.plugin(GoalService)
    await this.context.plugin(ToolGoal)
    await this.context.plugin(GoalRoundDriver)
    await this.context.plugin(SpillPolicy, { maxInlineBytes: 32_768 })
    await this.context.plugin(AgentRegistry)
    await installEdgeWebSearch(this.context, config.searchBaseURL)
    await this.context.plugin(DurableObjectSessionPersistence, { storage })
    const workspaceWasInitialized = (await storage.get<{ initialized?: boolean }>(
      'dsh-kv:workspace:__global__',
    ))?.initialized === true
    try {
      await this.context.plugin(WorkspaceRegistry)
    } catch (error) {
      console.error('dsh-edge: WorkspaceRegistry failed to initialize.', error)
      throw error
    }
    for (let i = 0; i < 100 && this.context.workspaceRegistry === undefined; i++) {
      await new Promise(r => setTimeout(r, 50))
    }
    if (this.context.workspaceRegistry.list().length === 0 && !workspaceWasInitialized) {
      await this.context.workspaceRegistry.create('/workspace')
    }
    await this.context.plugin(AgentLoop, { agents: [] })
    this.context.effect(
      () => this.context.tools.register(createEdgeBashTool(this.shells)),
      'dsh-edge: bash tool',
    )
    if (config.onLateSessionEvent !== undefined) {
      const callback = config.onLateSessionEvent
      const keepAlive = config.waitUntil
      this.context.on('session/event', (session, event) => {
        const agent = this.context.agents.get(session.id)
        if (agent?.session === session && this.turnPublishedAgents.has(agent)) return
        if (event.type === 'session/title' && event.data.source.kind === 'user') return
        const delivery = this.context.sessions.flush(session).then(() => {
          callback(session.id, event)
        }).catch((error: unknown) => {
          console.error('dsh-edge: failed to flush late session event.', error)
        })
        keepAlive?.(delivery)
      })
    }
  }

  /** Resolve the upstream workspace registry after initialization. */
  async workspaceRegistry(): Promise<WorkspaceRegistry> {
    await this.ready
    for (let i = 0; i < 100 && this.context.workspaceRegistry === undefined; i++) {
      await new Promise(r => setTimeout(r, 50))
    }
    return this.context.workspaceRegistry
  }

  spillStore(): EdgeVfsSpillStore | undefined {
    return this.context.get('spillStore') as EdgeVfsSpillStore | undefined
  }

  filesystem(): EdgeFileSystem | undefined {
    try { return this.context.fs as EdgeFileSystem } catch { return undefined }
  }

  liveAgent(sessionId: SessionId): Agent | undefined {
    const { agents } = this.context
    return agents.get(sessionId)
  }

  projectionSnapshot(sessionId: SessionId): { asOfSeq: number; values: Record<string, unknown> } | undefined {
    const agent = this.context.agents.get(sessionId)
    if (agent === undefined) return undefined
    return this.context.sessionProjections.snapshot(agent.session)
  }

  /** Resolve the optional upstream attachment service composed for this deployment. */
  async attachmentStore(): Promise<AttachmentStore | undefined> {
    await this.ready
    return this.context.get('attachments')
  }

  /** Project the deployment's authoritative upstream image policy. */
  async imageLimits(): Promise<ImageAttachmentLimits | undefined> {
    return (await this.attachmentStore())?.imageLimits
  }

  /** Check the current session selection through the upstream model catalog. */
  async modelSupportsImages(id: SessionId, defaultModel: string): Promise<boolean> {
    const selection = await this.modelSelection(id, defaultModel)
    const info = await this.context.llm.resolveModelInfo(selection.provider, selection.model)
    return info.inputModalities === undefined || info.inputModalities.includes('image')
  }

  /** Authorize one opaque attachment id against canonical session events. */
  async referencedImage(
    id: SessionId,
    attachmentId: string,
  ): Promise<ImageAttachmentRef | undefined> {
    const { sessions, persistence } = await this.services()
    const live = sessions.get(id)
    if (live !== undefined) return referencedImage(live.events, attachmentId)
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    if (persistence.readBlankSession(id) !== undefined) return undefined
    if (persistence.readSessionHeader(id) === undefined) {
      throw new EdgeSessionStoreError('NOT_FOUND', 'Session not found.')
    }
    return await findInEventPages(
      fromSeq => persistence.readEventPage(
        id,
        fromSeq,
        MAX_FORK_EVENTS,
        MAX_FORK_STORED_BYTES,
      ),
      events => referencedImage(events, attachmentId),
      id,
    )
  }

  /** Describe one credential through the mounted upstream provider without exposing its value. */
  async describeCredential(ref: string): Promise<CredentialInfo> {
    await this.ready
    return await this.context.credentials.describe(credentialRef(ref))
  }

  /** Persist one credential through the mounted upstream provider. */
  async setCredential(ref: string, value: string): Promise<void> {
    await this.ready
    await this.context.credentials.set(credentialRef(ref), value)
  }

  /** Remove one credential from the mounted upstream provider. */
  async unsetCredential(ref: string): Promise<void> {
    await this.ready
    await this.context.credentials.unset(credentialRef(ref))
  }

  /** List every configurable provider with its live/dormant state. */
  async listConfigurableProviders(): Promise<{
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: readonly string[]
    active: boolean
    declared?: boolean
  }[]> {
    await this.ready
    const live = new Set(this.context.llm.listProviders().map(p => p.id))
    return this.context.llm.listConfigurableProviders().map(entry => ({
      provider: entry.provider,
      displayName: entry.displayName,
      settingsNs: entry.settingsNs,
      settingsPath: [...entry.settingsPath],
      active: live.has(entry.provider),
      ...entry.declared === undefined ? {} : { declared: entry.declared },
    }))
  }

  /** List provider identities from the upstream LLM runtime. */
  async listLlmProviders(): Promise<{ id: string; name: string }[]> {
    await this.ready
    return this.context.llm.listProviders().map(p => ({ id: p.id, name: p.name }))
  }

  /** Whether the mounted settings provider accepts runtime writes. */
  async settingsWritable(): Promise<boolean> {
    await this.ready
    return this.context.settings?.writable ?? false
  }

  /** Whether the mounted settings provider owns a user-editable file. */
  async settingsHasDocument(): Promise<boolean> {
    await this.ready
    return this.context.settings?.documentPath !== undefined
  }

  /** Describe all registered settings namespaces with redacted secrets. */
  async describeSettings(): Promise<SettingsDescriptor[]> {
    await this.ready
    return this.context.settings?.describe({ redactSecrets: true }) ?? []
  }

  /** Merge a patch into one namespace's user section. */
  async updateSettings(
    ns: string,
    patch: object,
    expectedRevision?: number,
  ): Promise<SettingsDescriptor | undefined> {
    await this.ready
    await this.context.settings.update(settingsNamespace(ns), patch, expectedRevision)
    return this.context.settings.describe({ redactSecrets: true })
      .find(d => (d.ns as string) === ns)
  }

  /** Replace one namespace's user section wholesale. */
  async replaceSettings(
    ns: string,
    section: object,
    expectedRevision?: number,
  ): Promise<SettingsDescriptor | undefined> {
    await this.ready
    await this.context.settings.replace(settingsNamespace(ns), section, expectedRevision)
    return this.context.settings.describe({ redactSecrets: true })
      .find(d => (d.ns as string) === ns)
  }

  /** Apply path-addressed edits to one namespace's user section. */
  async mutateSettings(
    ns: string,
    ops: readonly SettingsPathOp[],
    expectedRevision?: number,
  ): Promise<SettingsDescriptor | undefined> {
    await this.ready
    await this.context.settings.mutate(settingsNamespace(ns), ops, expectedRevision)
    return this.context.settings.describe({ redactSecrets: true })
      .find(d => (d.ns as string) === ns)
  }

  /** Project the registered upstream provider catalog into the upstream Web wire shape. */
  async modelCatalog(): Promise<{
    groups: ModelProviderGroup[]
    failures: ModelCatalogFailure[]
  }> {
    await this.ready
    const catalog = await Promise.all(this.context.llm.listProviders().map(async (provider) => {
      try {
        const models = await this.context.llm.listModels(provider.id)
        const entries = await Promise.all(models.map(async (model) => {
          const resolved = await this.context.llm.resolveModelInfo(provider.id, model.id)
          const reasoning: ModelReasoning | undefined = resolved.reasoning === undefined
            ? undefined
            : {
                efforts: resolved.reasoning.efforts.map(effort => ({
                  id: effort.id,
                  name: effort.name,
                  ...effort.description === undefined
                    ? {}
                    : { description: effort.description },
                })),
                ...resolved.reasoning.defaultEffort === undefined
                  ? {}
                  : { defaultEffort: resolved.reasoning.defaultEffort },
              }
          return {
            id: model.id,
            name: model.name,
            ...model.description === undefined ? {} : { description: model.description },
            ...reasoning === undefined ? {} : { reasoning },
          }
        }))
        return {
          kind: 'group' as const,
          group: { id: provider.id, name: provider.name, models: entries },
        }
      } catch (error) {
        return {
          kind: 'failure' as const,
          failure: {
            id: provider.id,
            name: provider.name,
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }))
    return {
      groups: catalog.flatMap(item => item.kind === 'group' && item.group.models.length > 0
        ? [item.group]
        : []),
      failures: catalog.flatMap(item => item.kind === 'failure' ? [item.failure] : []),
    }
  }

  /** Resolve the selection using the same pending → logged → default order as upstream ApiProxy. */
  async modelSelection(id: SessionId, defaultModel: string): Promise<ModelSelection> {
    const { sessions, persistence } = await this.services()
    const pending = await this.loadModelSelection(id)
    if (pending !== undefined) return pending
    const live = sessions.get(id)
    if (live !== undefined) return loggedModelSelection(live.requestHeader()?.config, defaultModel)
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    if (persistence.readBlankSession(id) !== undefined) return defaultModelSelection(defaultModel)
    if (persistence.readSessionHeader(id) === undefined) {
      throw new EdgeSessionStoreError('NOT_FOUND', 'Session not found.')
    }
    return loggedModelSelection(persistence.readLatestModelSelection(id), defaultModel)
  }

  /** Validate and install one session-local selection through the upstream LLM resolver. */
  async selectModel(
    id: SessionId,
    input: { provider: string; model: string; reasoningEffort?: string },
  ): Promise<ModelSelection> {
    await this.requireSession(id)
    const resolved = await this.context.llm.resolveCallConfig({
      provider: input.provider,
      model: input.model,
      ...input.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(input.reasoningEffort) },
    })
    const info = await this.context.llm.resolveModelInfo(resolved.provider, resolved.model)
    if (info.inputModalities !== undefined && !info.inputModalities.includes('image')
      && await this.sessionContainsImages(id)) {
      throw new Error(
        `Model "${resolved.model}" does not accept image input, but this session already contains images.`,
      )
    }
    const selected: ModelSelection = {
      provider: resolved.provider,
      model: resolved.model,
      ...resolved.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: resolved.reasoningEffort },
    }
    await this.modelSelections.save(id, selected)
    return selected
  }

  private async sessionContainsImages(id: SessionId): Promise<boolean> {
    const { agents, sessions, persistence } = await this.services()
    const agent = agents.get(id)
    if (agent !== undefined && [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
      .some(message => message.content.some(block => block.type === 'image'))) return true
    const live = sessions.get(id)
    if (live !== undefined) return appendSurfaceContainsImage(live.events)
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    if (persistence.readBlankSession(id) !== undefined) return false
    const header = persistence.readSessionHeader(id)
    if (header === undefined) throw new EdgeSessionStoreError('NOT_FOUND', 'Session not found.')
    const inbox: EffectiveInboxState = { 'next-turn': [], 'next-step': [] }
    const surfaceImage = await findInEventPages(
      fromSeq => persistence.readEventPage(
        id,
        fromSeq,
        MAX_FORK_EVENTS,
        MAX_FORK_STORED_BYTES,
      ),
      events => {
        for (const event of events) {
          if (isAppendSurfaceEvent(event) && referencedImage([event]) !== undefined) return true
          if (event.seq >= (header.seedLength ?? 0) && event.type === 'agent/inbox/spliced') {
            applyEffectiveInboxSplice(inbox, event.data)
          }
        }
        return undefined
      },
      id,
    )
    return surfaceImage === true || effectiveInboxContainsImage(inbox)
  }

  async createSession(input: CreateEdgeSessionInput & { cwd?: string }): Promise<EdgeSession> {
    const { agents, sessions, persistence } = await this.services()
    const title = normalizeSessionTitle(input.title, MAX_TITLE_BYTES)
    if (title.length === 0) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Session title must contain visible text.')
    }
    const id = SessionId(crypto.randomUUID())
    const handle = await agents.create({
      sessionId: id,
      meta: {
        cwd: input.cwd ?? '/workspace',
        agentPreset: 'dsh-edge',
      },
      agentOptions: { provider: EDGE_PROVIDER, model: DEFAULT_EDGE_MODEL },
      setup: agentCtx => this.installAgentModelSelection(agentCtx, DEFAULT_EDGE_MODEL),
    })
    const { agent } = handle
    const { session } = agent
    try {
      session.append('session/title', {
        title,
        messageSeqs: [],
        source: { kind: 'user' },
      })
      // Upstream session creation is intentionally lazy. The required title
      // supplies the first canonical event before this HTTP API returns 201.
      await sessions.flush(session)
      return summarize(session.header, session.events)
    } catch (error) {
      if (!(persistence instanceof DurableObjectSessionPersistence)) {
        throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
      }
      await persistence.abandonUnmaterializedSession(session)
      throw error
    } finally {
      await handle.dispose().catch((disposeError: unknown) => {
        console.error('dsh-edge failed to release the created session.', disposeError)
      })
    }
  }

  /** Create the lazy blank session expected by the upstream Web client. */
  async createBlankSession(input: {
    sessionId?: SessionId
    model: string
    cwd?: string
  }): Promise<{ sessionId: SessionId; agentPreset: string; created: boolean }> {
    const { agents, sessions, persistence } = await this.services()
    const id = input.sessionId ?? SessionId(`session-${crypto.randomUUID()}`)
    const sessionCwd = input.cwd ?? '/workspace'
    const attached = sessions.get(id)
    if (attached !== undefined) {
      rejectCwdConflict(input.cwd, attached.header.cwd)
      return {
        sessionId: id,
        agentPreset: attached.header.agentPreset ?? 'dsh-edge',
        created: false,
      }
    }
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    const stored = persistence.readSessionSummary(id)
    if (stored !== undefined) {
      rejectCwdConflict(input.cwd, stored.meta.cwd)
      return {
        sessionId: id,
        agentPreset: stored.meta.agentPreset ?? 'dsh-edge',
        created: false,
      }
    }
    const retainedBlank = persistence.readBlankSession(id)
    if (retainedBlank !== undefined) {
      rejectCwdConflict(input.cwd, retainedBlank.cwd)
      return {
        sessionId: id,
        agentPreset: retainedBlank.agentPreset ?? 'dsh-edge',
        created: false,
      }
    }
    const handle = await agents.create({
      sessionId: id,
      meta: { cwd: sessionCwd, agentPreset: 'dsh-edge' },
      agentOptions: { provider: EDGE_PROVIDER, model: input.model },
      setup: agentCtx => this.installAgentModelSelection(agentCtx, input.model),
    })
    try {
      await persistence.retainBlankSession(handle.agent.session.header)
      this.blankHandles.set(id, handle)
      return { sessionId: id, agentPreset: 'dsh-edge', created: true }
    } catch (error) {
      await persistence.abandonUnmaterializedSession(handle.agent.session)
      await handle.dispose().catch((disposeError: unknown) => {
        console.error('dsh-edge failed to roll back blank session creation.', disposeError)
      })
      throw error
    }
  }

  async listSessions(
    after: SessionId | undefined,
    limit: number,
  ): Promise<EdgeSessionListPage | undefined> {
    const { persistence } = await this.services()
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    const page = persistence.readSessionSummaryPage(after, limit)
    if (page === undefined) return undefined
    const sessions = page.sessions.map(summarizeStored)
    const last = sessions.at(-1)
    return {
      sessions,
      hasMore: page.hasMore,
      ...last === undefined ? {} : { nextAfter: last.id },
    }
  }

  async getSession(id: SessionId): Promise<EdgeSession | undefined> {
    const { persistence } = await this.services()
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    const stored = persistence.readSessionSummary(id)
    if (stored !== undefined) return summarizeStored(stored)
    const blank = persistence.readBlankSession(id)
    return blank === undefined ? undefined : summarize(blank, [])
  }

  /** Read every session summary using the upstream list semantics. */
  async listApiSessions(): Promise<EdgeApiSessionSummary[]> {
    const { sessions, persistence } = await this.services()
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    return collectApiSessions(sessions, persistence)
  }

  /** Read one upstream API summary without scanning the workspace registry. */
  async getApiSessionSummary(id: SessionId): Promise<EdgeApiSessionSummary> {
    const { sessions, persistence } = await this.services()
    const live = sessions.get(id)
    if (live !== undefined) return summarizeApiLive(live.header, live.events)
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    const stored = persistence.readSessionSummary(id)
    if (stored !== undefined) return summarizeApiStored(stored)
    const blank = persistence.readBlankSession(id)
    if (blank !== undefined) return summarizeApiLive(blank, [])
    throw new EdgeSessionStoreError('NOT_FOUND', 'Session not found.')
  }

  /**
   * Search a fixed work budget of canonical current-message surfaces for the sidebar.
   * @param query - Non-empty query already validated by the upstream carrier.
   * @param signal - Request cancellation, checked between session reads.
   * @returns Up to the upstream result limit; `hasMore` also reports skipped over-budget logs.
   */
  async searchApiSessions(query: string, signal?: AbortSignal): Promise<EdgeSessionSearchPage> {
    signal?.throwIfAborted()
    const { sessions, persistence } = await this.services()
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    const summaries = collectRecentApiSessions(persistence, MAX_SEARCH_SESSIONS + 1)
    const candidates = summaries.slice(0, MAX_SEARCH_SESSIONS)
    let hasMore = summaries.length > candidates.length
    const items: SessionSearchItem[] = []
    const normalizedQuery = normalizeSearchText(query)

    for (const summary of candidates) {
      signal?.throwIfAborted()
      const live = sessions.get(summary.id)
      let events: readonly SessionEvent[]
      if (live !== undefined) {
        await sessions.flush(live)
        if (live.events.length > MAX_SEARCH_EVENTS_PER_SESSION) {
          hasMore = true
          continue
        }
        events = live.events
      } else if (persistence.readBlankSession(summary.id) !== undefined) {
        continue
      } else {
        const page = await persistence.readEventPage(
          summary.id,
          0,
          MAX_SEARCH_EVENTS_PER_SESSION,
          MAX_SEARCH_STORED_BYTES_PER_SESSION,
          signal,
        )
        if (page.hasMore) {
          hasMore = true
          continue
        }
        events = page.events
      }
      const match = buildSessionEventSearchDocuments(summary.id, events)
        .findLast(document => document.surface === 'current'
          && MESSAGE_TYPES.has(document.type)
          && normalizeSearchText(document.text).includes(normalizedQuery))
      if (match === undefined) continue
      items.push({
        sessionId: summary.id,
        snippet: searchSnippet(match.text, query, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
      })
      if (items.length > SESSION_SEARCH_RESULT_LIMIT) {
        return { items: items.slice(0, SESSION_SEARCH_RESULT_LIMIT), hasMore: true }
      }
    }
    return { items, hasMore }
  }

  /** Consume mux baselines synchronously with socket registration after readiness. */
  async withMuxBaseline<T>(consume: (baseline: EdgeMuxBaseline) => T): Promise<T> {
    const { agents, sessions, persistence } = await this.services()
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    const queues: EdgeMuxBaseline['queues'] = []
    for (const session of sessions.list()) {
      const agent = agents.get(session.id)
      if (agent?.session !== session || !agent.inbox.hasPending) continue
      queues.push({ sessionId: session.id, items: queueItems(agent) })
    }
    return consume({ sessions: collectApiSessions(sessions, persistence), queues })
  }

  /** Require one live, canonical, or retained-blank session using only point reads. */
  async requireSession(id: SessionId): Promise<void> {
    const { sessions, persistence } = await this.services()
    if (sessions.get(id) !== undefined) return
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    if (persistence.readSessionHeader(id) !== undefined
      || persistence.readBlankSession(id) !== undefined) return
    throw new EdgeSessionStoreError('NOT_FOUND', 'Session not found.')
  }

  /** Page live history in memory or cold history at the Durable Object SQL boundary. */
  async readHistoryPage(
    id: SessionId,
    beforeSeq: number | undefined,
    maxMessages: number,
  ): Promise<EdgeSessionHistoryPage> {
    const { sessions, persistence } = await this.services()
    const boundedMaxMessages = Math.min(maxMessages, EDGE_HISTORY_PAGE_LIMITS.maxMessages)
    const live = sessions.get(id)
    if (live !== undefined) {
      const page = paginateHistory(live.events, beforeSeq, boundedMaxMessages)
      return {
        summary: summarizeApiLive(live.header, live.events),
        events: page.events,
        hasMore: page.hasMore,
      }
    }
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    const blank = persistence.readBlankSession(id)
    if (blank !== undefined) {
      return { summary: summarizeApiLive(blank, []), events: [], hasMore: false }
    }
    const page = await persistence.readHistoryPage(id, beforeSeq, boundedMaxMessages)
    if (page === undefined) throw new EdgeSessionStoreError('NOT_FOUND', 'Session not found.')
    return {
      summary: summarizeApiStored(page.summary),
      events: page.events,
      hasMore: page.hasMore,
    }
  }

  /** Fork one completed-turn prefix through the upstream Session seed format. */
  async forkSession(
    id: SessionId,
    atSeq: number | undefined,
    model: string,
  ): Promise<EdgeApiSessionSummary> {
    const { agents, sessions, persistence } = await this.services()
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    const live = sessions.get(id)
    let header: SessionHeader
    let events: readonly SessionEvent[]
    if (live !== undefined) {
      header = live.header
      events = live.events
    } else {
      const blank = persistence.readBlankSession(id)
      if (blank !== undefined) {
        header = blank
        events = []
        return await this.createForkedSession(agents, sessions, persistence, id, header, events, atSeq, model)
      }
      if (persistence.readSessionHeader(id) === undefined) {
        throw new EdgeSessionStoreError('NOT_FOUND', 'Session not found.')
      }
      const page = await persistence.readEventPage(
        id,
        0,
        MAX_FORK_EVENTS,
        MAX_FORK_STORED_BYTES,
      )
      if (page.hasMore) {
        throw new EdgeSessionStoreError(
          'FORK_UNAVAILABLE',
          `Session ${id} exceeds the Edge fork history limit.`,
        )
      }
      header = page.meta
      events = page.events
    }
    return await this.createForkedSession(agents, sessions, persistence, id, header, events, atSeq, model)
  }

  private async createForkedSession(
    agents: AgentRegistry,
    sessions: SessionStore,
    persistence: DurableObjectSessionPersistence,
    id: SessionId,
    header: SessionHeader,
    events: readonly SessionEvent[],
    atSeq: number | undefined,
    model: string,
  ): Promise<EdgeApiSessionSummary> {
    const seed = completedForkSeed(id, events, atSeq)
    assertForkSeedWithinLimits(id, seed)
    const childId = SessionId(`session-${crypto.randomUUID()}`)
    const handle = await agents.create({
      sessionId: childId,
      seed,
      meta: {
        ...header.cwd === undefined ? {} : { cwd: header.cwd },
        parentSession: id,
        seedLength: seed.length,
        agentPreset: header.agentPreset ?? 'dsh-edge',
      },
      agentOptions: { provider: EDGE_PROVIDER, model },
      setup: agentCtx => this.installAgentModelSelection(agentCtx, model),
    })
    try {
      await sessions.flush(handle.agent.session)
      return summarizeApiLive(handle.agent.session.header, handle.agent.session.events)
    } catch (error) {
      await persistence.abandonUnmaterializedSession(handle.agent.session)
      throw error
    } finally {
      await handle.dispose().catch((disposeError: unknown) => {
        console.error('dsh-edge failed to release the forked session.', disposeError)
      })
    }
  }

  /**
   * Append the canonical user-owned title event to a live or cold session.
   *
   * Upstream defines the synchronous append as the rename commit point. Its
   * persistence coordinator owns write-behind and retirement retries, so this
   * RPC must not report rejection after the accepted event can still commit.
   * The result also transfers delivery to the caller only when no turn observer
   * owned the event at that same synchronous append point.
   */
  async renameSession(
    id: SessionId,
    title: string,
    model: string,
  ): Promise<{
    title: string
    event: SessionEvent<'session/title'>
    publishRequired: boolean
  }> {
    const normalized = normalizeSessionTitle(title, MAX_TITLE_BYTES)
    if (normalized.length === 0) {
      throw new EdgeSessionStoreError('TITLE_INVALID', 'Session title must contain visible text.')
    }
    const { agents } = await this.services()
    const live = agents.get(id)
    // Retained blanks still belong to this store: claim and retire their
    // handle below. Every other registered agent may be running; metadata
    // appends are valid while its turn owns the process-local handle.
    if (live !== undefined && !this.blankHandles.has(id)) {
      const publishRequired = !this.turnPublishedAgents.has(live)
      return { title: normalized, event: appendUserTitle(live, normalized), publishRequired }
    }

    const handle = await this.openAgentForTurn(id, model)
    try {
      return {
        title: normalized,
        event: appendUserTitle(handle.agent, normalized),
        publishRequired: true,
      }
    } finally {
      await handle.dispose().catch((disposeError: unknown) => {
        console.error('dsh-edge failed to release the renamed session.', disposeError)
      })
    }
  }

  /** Count live Agent owners for host.describe. */
  async attachedSessionCount(): Promise<number> {
    const { agents } = await this.services()
    return agents.list().length
  }

  /** Resolve a live native agent, or cold-resume it through upstream persistence. */
  async openAgentForTurn(id: SessionId, model: string): Promise<AgentHandle> {
    const { agents, persistence } = await this.services()
    await this.loadModelSelection(id)
    const blank = this.blankHandles.get(id)
    if (blank !== undefined) {
      this.blankHandles.delete(id)
      return blank
    }
    if (agents.get(id) !== undefined) {
      throw new EdgeSessionStoreError('BUSY', 'Session already has a live agent owner.')
    }
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    if (!persistence.hasSession(id)) {
      const retainedBlank = persistence.readBlankSession(id)
      if (retainedBlank === undefined) {
        throw new EdgeSessionStoreError('NOT_FOUND', 'Session not found.')
      }
      await persistence.materializeBlankSession(id)
    }
    const handle = await agents.resume({
      resumeSessionId: id,
      agentOptions: { provider: EDGE_PROVIDER, model },
      setup: agentCtx => this.installAgentModelSelection(agentCtx, model),
    })
    try {
      await this.context.sessions.flush(handle.agent.session)
      return handle
    } catch (error) {
      await handle.dispose().catch((disposeError: unknown) => {
        console.error('dsh-edge failed to roll back agent resume.', disposeError)
      })
      throw error
    }
  }

  /** Mount the upstream per-agent selection seam before the Agent is published. */
  private installAgentModelSelection(agentCtx: Context, defaultModel: string): void {
    const agent = agentCtx.agent
    if (agent === undefined) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Agent setup has no scoped Agent.')
    }
    let assembled: ModelSelection | undefined
    const selections = this.modelSelections
    const selection: ModelSelectionRef = {
      get current() {
        return selections.current(agent.id)
          ?? loggedModelSelection(agent.session.requestHeader()?.config, defaultModel)
      },
      set current(next) {
        selections.setCurrent(agent.id, next)
      },
      get assembled() {
        return assembled
      },
      set assembled(next) {
        assembled = next
      },
    }
    installModelSelection(agentCtx, selection)
  }

  /** Hydrate the process cache from Durable Object KV after hibernation. */
  private async loadModelSelection(id: SessionId): Promise<ModelSelection | undefined> {
    return await this.modelSelections.load(id)
  }

  /** Retire the Edge bridge after the matching upstream request header is durable. */
  private async retireLoggedModelSelection(agent: Agent): Promise<void> {
    const config = agent.session.requestHeader()?.config
    if (config?.provider === undefined || config.model === undefined) return
    await this.modelSelections.clearIfLogged(
      agent.id,
      loggedModelSelection(config, DEFAULT_EDGE_MODEL),
    )
  }

  /** Drive one turn through ReactLoopAgent and publish only durable events. */
  async runAgentTurn(input: {
    agent: Agent
    mode: 'queue' | 'steer'
    content: ContentBlock[]
    rpcId?: RpcId
    clientTimeZone?: string
    shell: EdgeShell
    publish: (event: SessionEvent) => void | Promise<void>
    publishQueue?: (items: QueuedInboxItem[]) => void | Promise<void>
    afterFollowup?: () => void
    onAdmitted?: (admit: EdgeAgentPromptAdmitter) => void
    onClosing?: () => void
  }): Promise<void> {
    const { sessions } = await this.services()
    const { agent } = input
    if (this.context.agents.get(agent.id) !== agent || sessions.get(agent.id) !== agent.session) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Agent is not the live persistence owner.')
    }

    const releaseShell = this.shells.bind(
      agent.id,
      input.shell,
      agent.session.header.cwd ?? '/workspace',
    )
    let delivery = Promise.resolve()
    let deliveryError: unknown
    const stopObserving = this.context.on('session/event', (subject, event) => {
      if (subject !== agent.session) return
      const queue = event.type === 'agent/inbox/spliced'
        ? queueItems(agent, event.data)
        : undefined
      delivery = delivery.then(async () => {
        await sessions.flush(agent.session)
        if (deliveryError !== undefined) return
        try {
          await input.publish(event)
          if (queue !== undefined) await input.publishQueue?.(queue)
        } catch (error) {
          deliveryError = error
        }
      })
    })
    this.turnPublishedAgents.add(agent)
    const admission = createDurablePromptAdmitter(
      this.context,
      agent,
      () => sessions.flush(agent.session),
    )

    try {
      const admitted = admission.admit({
        mode: input.mode,
        content: input.content,
        ...input.rpcId === undefined ? {} : { rpcId: input.rpcId },
        ...input.clientTimeZone === undefined
          ? {}
          : { clientTimeZone: input.clientTimeZone },
      })
      input.afterFollowup?.()
      await admitted
      input.onAdmitted?.(admission.admit)
      while (true) {
        await agent.whenIdle()
        if (agent.status !== 'idle') continue
        input.onClosing?.()
        break
      }
      await delivery
      await sessions.flush(agent.session)
      await this.retireLoggedModelSelection(agent).catch((error: unknown) => {
        // A retained matching bridge is harmless and can be retried after the next turn.
        console.error('dsh-edge failed to retire a logged model selection.', error)
      })
    } finally {
      await delivery.catch(() => {})
      await agent.whenIdle().catch(() => {})
      admission.dispose()
      stopObserving()
      this.turnPublishedAgents.delete(agent)
      releaseShell()
    }
  }

  async readEventPage(
    id: SessionId,
    fromSeq: number,
    limit: number,
    maxStoredBytes: number,
  ): Promise<EdgeEventPage> {
    const { persistence } = await this.services()
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    try {
      return await persistence.readEventPage(id, fromSeq, limit, maxStoredBytes)
    } catch (error) {
      if (error instanceof Error && error.message === `session "${id}" not found`) {
        throw new EdgeSessionStoreError('NOT_FOUND', 'Session not found.')
      }
      throw error
    }
  }

  private async services(): Promise<{
    agents: AgentRegistry
    sessions: SessionStore
    persistence: SessionPersistence
  }> {
    await this.ready
    return {
      agents: this.context.agents,
      sessions: this.context.sessions,
      persistence: this.context.sessionPersistence,
    }
  }
}

function appendUserTitle(agent: Agent, title: string): SessionEvent<'session/title'> {
  return agent.session.append('session/title', {
    title,
    messageSeqs: [],
    source: { kind: 'user' },
  })
}

function referencedImage(
  events: readonly SessionEvent[],
  attachmentId?: string,
): ImageAttachmentRef | undefined {
  for (const event of events) {
    const data = event.data as unknown
    if (!isRecord(data)) continue
    const direct = imageBlockIn(data.content, attachmentId)
    if (direct !== undefined) return direct
    if (isRecord(data.message)) {
      const wrapped = imageBlockIn(data.message.content, attachmentId)
      if (wrapped !== undefined) return wrapped
    }
    if (Array.isArray(data.inserted)) {
      for (const message of data.inserted) {
        if (!isRecord(message)) continue
        const inserted = imageBlockIn(message.content, attachmentId)
        if (inserted !== undefined) return inserted
      }
    }
    if (event.type === 'assistant/chunk' && isRecord(data.chunk)
      && data.chunk.type === 'block-end') {
      const chunk = imageBlockIn([data.chunk.block], attachmentId)
      if (chunk !== undefined) return chunk
    }
  }
  return undefined
}

type EffectiveInboxState = Record<'next-turn' | 'next-step', UserMessage[]>

function appendSurfaceContainsImage(events: readonly SessionEvent[]): boolean {
  return events.some(event => isAppendSurfaceEvent(event)
    && referencedImage([event]) !== undefined)
}

/** Fold the same normalized durable splice semantics as the upstream Agent inbox. */
function applyEffectiveInboxSplice(
  inbox: EffectiveInboxState,
  splice: SessionEventMap['agent/inbox/spliced'],
): void {
  inbox[splice.target].splice(
    splice.start,
    splice.removedCount ?? 0,
    ...splice.inserted,
  )
}

function effectiveInboxContainsImage(inbox: EffectiveInboxState): boolean {
  return [...inbox['next-turn'], ...inbox['next-step']]
    .some(message => message.content.some(block => block.type === 'image'))
}

/** Evaluate a full-history predicate through bounded pages without a total-session limit. */
export async function findInEventPages<T>(
  readPage: (fromSeq: number) => Promise<EdgeEventPage>,
  find: (events: readonly SessionEvent[]) => T | undefined,
  sessionId: SessionId,
): Promise<T | undefined> {
  let fromSeq = 0
  while (true) {
    const page = await readPage(fromSeq)
    const found = find(page.events)
    if (found !== undefined || !page.hasMore) return found
    const lastSeq = page.events.at(-1)?.seq
    if (lastSeq === undefined || lastSeq < fromSeq) {
      throw new EdgeSessionStoreError(
        'INVALID_DATA',
        `Session ${sessionId} contains an event that exceeds the Edge history scan page limit.`,
      )
    }
    fromSeq = lastSeq + 1
  }
}

function imageBlockIn(
  content: unknown,
  attachmentId?: string,
): ImageAttachmentRef | undefined {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (!isRecord(value)) continue
    if (value.type === 'image' && isRecord(value.attachment)
      && (attachmentId === undefined
        || String(value.attachment.attachmentId) === attachmentId)) {
      return value.attachment as unknown as ImageAttachmentRef
    }
    if (value.type === 'tool-result') {
      const nested = imageBlockIn(value.content, attachmentId)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collapseSearchWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function normalizeSearchText(value: string): string {
  return collapseSearchWhitespace(value).toLowerCase()
}

function searchMatchStart(
  characters: readonly string[],
  query: string,
): number {
  const sourceCodePointByCodeUnit: number[] = []
  for (const [sourceIndex, character] of characters.entries()) {
    const folded = character.toLowerCase()
    for (let offset = 0; offset < folded.length; offset += 1) {
      sourceCodePointByCodeUnit.push(sourceIndex)
    }
  }
  // Preserve whole-string Unicode lowercasing semantics (for example, final
  // sigma) while the per-code-point folded lengths provide the source map.
  const normalized = characters.join('').toLowerCase()
  if (sourceCodePointByCodeUnit.length !== normalized.length) {
    throw new TypeError('Search normalization produced an unmappable source offset.')
  }
  const matchIndex = normalized.indexOf(normalizeSearchText(query))
  return matchIndex < 0 ? 0 : sourceCodePointByCodeUnit[matchIndex] ?? 0
}

/**
 * Build a plain-text excerpt around one literal match under the upstream wire bound.
 * @param text - Complete searchable message text.
 * @param query - Literal normalized match selected by the caller.
 * @param maximum - Maximum Unicode code points in the result.
 * @returns A whitespace-normalized excerpt with edge ellipses when truncated.
 */
export function searchSnippet(text: string, query: string, maximum: number): string {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new TypeError('Search snippet maximum must be a positive safe integer.')
  }
  const clean = collapseSearchWhitespace(text)
  const characters = Array.from(clean)
  if (characters.length <= maximum) return clean
  // Search the same whitespace-collapsed code points that the excerpt slices,
  // retaining their source positions across length-changing Unicode case folds.
  const matchStart = searchMatchStart(characters, query)
  let start = Math.max(0, matchStart - Math.floor(maximum / 3))
  let prefix = start > 0 ? '…' : ''
  let suffix = '…'
  let contentLength = maximum - prefix.length - suffix.length
  if (contentLength < 1) {
    start = matchStart
    prefix = start > 0 ? '…' : ''
    suffix = ''
    contentLength = maximum - prefix.length
  } else if (matchStart >= start + contentLength) {
    start = matchStart - contentLength + 1
  }
  let end = Math.min(characters.length, start + contentLength)
  if (end === characters.length) {
    suffix = ''
    contentLength = maximum - prefix.length
    start = Math.max(0, end - contentLength)
    prefix = start > 0 ? '…' : ''
  }
  end = Math.min(characters.length, start + maximum - prefix.length - suffix.length)
  return `${prefix}${characters.slice(start, end).join('')}${suffix}`
}

function completedForkSeed(
  id: SessionId,
  events: readonly SessionEvent[],
  atSeq: number | undefined,
): SessionEvent[] {
  const lastSeq = events.at(-1)?.seq ?? -1
  const anchoredBoundary = atSeq === undefined
    ? undefined
    : events.find(event => event.type === 'turn/end' && event.seq >= atSeq)
  const boundary = anchoredBoundary
    ?? (atSeq === undefined || atSeq > lastSeq
      ? events.findLast(event => event.type === 'turn/end')
      : undefined)
  if (boundary === undefined) {
    throw new EdgeSessionStoreError(
      'FORK_UNAVAILABLE',
      atSeq !== undefined && atSeq <= lastSeq
        ? `Session ${id} has not completed the turn containing event ${String(atSeq)}.`
        : `Session ${id} has no completed turn to fork from.`,
    )
  }
  let cut = boundary.seq + 1
  while (cut < events.length && events[cut]?.type !== 'turn/start') cut++
  return events.slice(0, cut)
}

function assertForkSeedWithinLimits(id: SessionId, seed: readonly SessionEvent[]): void {
  if (seed.length > MAX_FORK_EVENTS
    || new TextEncoder().encode(JSON.stringify(seed)).byteLength > MAX_FORK_STORED_BYTES) {
    throw new EdgeSessionStoreError(
      'FORK_UNAVAILABLE',
      `Session ${id} exceeds the Edge fork history limit.`,
    )
  }
}

/** Gate model-visible prompt consumption on the Edge persistence flush barrier. */
export function createDurablePromptAdmitter(
  ctx: Context,
  agent: Agent,
  flush: () => Promise<unknown>,
): { admit: EdgeAgentPromptAdmitter; dispose(): void } {
  const gates = new Map<string, Promise<boolean>>()
  const stop = ctx.on('agent/pre-step', async ({ agent: subject, messages }, next) => {
    if (subject !== agent) return next()
    for (const message of messages) {
      const gate = gates.get(message.id)
      if (gate === undefined) continue
      const durable = await gate
      gates.delete(message.id)
      if (!durable) return { kind: 'reject' as const }
    }
    return next()
  })
  const admit: EdgeAgentPromptAdmitter = async (prompt) => {
    const message = createUserMessage({
      content: prompt.content,
      source: prompt.rpcId === undefined
        ? { kind: 'user' }
        : {
          kind: 'user',
          rpcId: prompt.rpcId,
          ...prompt.clientTimeZone === undefined
            ? {}
            : { clientTimeZone: prompt.clientTimeZone },
        },
    })
    const gate = Promise.withResolvers<boolean>()
    gates.set(message.id, gate.promise)
    try {
      if (prompt.mode === 'steer') agent.steer(message)
      else agent.followup(message)
    } catch (error) {
      gate.resolve(false)
      gates.delete(message.id)
      throw error
    }
    try {
      await flush()
      gate.resolve(true)
    } catch {
      // The inbox mutation already woke the driver, so this prompt remains
      // accepted. Reject model-visible consumption; the turn's delivery
      // barrier reports the persistence failure through host/agent-error.
      gate.resolve(false)
    }
  }
  return {
    admit,
    dispose() {
      stop()
      gates.clear()
    },
  }
}

/** Project both inbox targets, optionally applying the splice currently being emitted. */
function queueItems(
  agent: Agent,
  splice?: SessionEventMap['agent/inbox/spliced'],
): QueuedInboxItem[] {
  const project = (target: 'next-turn' | 'next-step'): readonly UserMessage[] => {
    const messages = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep
    return splice?.target === target
      ? messages.toSpliced(splice.start, splice.removedCount ?? 0, ...splice.inserted)
      : messages
  }
  return [
    ...project('next-turn').map(message => ({
      id: message.id,
      placement: 'queued' as const,
      message,
    })),
    ...project('next-step').map(message => ({
      id: message.id,
      placement: message.source.kind === 'user' ? 'steering' as const : 'context' as const,
      message,
    })),
  ]
}

function collectApiSessions(
  sessions: SessionStore,
  persistence: DurableObjectSessionPersistence,
): EdgeApiSessionSummary[] {
  const summaries = new Map<SessionId, EdgeApiSessionSummary>()
  for (const blank of persistence.readAllBlankSessions()) {
    summaries.set(blank.id, summarizeApiLive(blank, []))
  }
  for (const stored of persistence.readAllSessionSummaries()) {
    summaries.set(stored.meta.id, summarizeApiStored(stored))
  }
  for (const session of sessions.list()) {
    summaries.set(session.id, summarizeApiLive(session.header, session.events))
  }
  return [...summaries.values()].sort((left, right) =>
    right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}

function collectRecentApiSessions(
  persistence: DurableObjectSessionPersistence,
  limit: number,
): EdgeApiSessionSummary[] {
  return [
    ...persistence.readRecentBlankSessions(limit).map(blank => summarizeApiLive(blank, [])),
    ...persistence.readRecentSessionSummaries(limit).map(summarizeApiStored),
  ].sort((left, right) =>
    right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)).slice(0, limit)
}

function summarizeApiLive(
  header: SessionHeader,
  events: readonly SessionEvent[],
): EdgeApiSessionSummary {
  const prompt = events.findLast(event =>
    event.type === 'user/message' && event.data.source.kind === 'user')
  return {
    id: header.id,
    title: foldSessionTitle(events)?.title ?? null,
    createdAt: header.createdAt,
    lastPromptAt: prompt?.time ?? null,
    updatedAt: prompt?.time ?? header.createdAt,
    lastSeq: events.at(-1)?.seq ?? -1,
    blank: !events.some(event => event.type === 'turn/start'),
    ...header.parentSession === undefined ? {} : { parentSessionId: header.parentSession },
    ...header.origin === undefined ? {} : { origin: header.origin },
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
  }
}

function buildEdgeLlmPluginConfig(config: EdgeSessionStoreConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (config.baseURL !== undefined) out['baseURL'] = config.baseURL
  if (config.maxTokens !== undefined) {
    const n = Number(config.maxTokens)
    if (Number.isFinite(n)) out['maxTokens'] = n
  }
  if (config.reasoningEffort !== undefined) out['reasoningEffort'] = config.reasoningEffort
  if (config.streamIdleTimeoutMs !== undefined) {
    const n = Number(config.streamIdleTimeoutMs)
    if (Number.isFinite(n)) out['streamIdleTimeoutMs'] = n
  }
  return out
}

function defaultModelSelection(model: string): ModelSelection {
  return { provider: EDGE_PROVIDER, model }
}

/** Rebuild the session-local selection from its latest full request header. */
function loggedModelSelection(
  config: { provider?: string; model?: string; reasoningEffort?: string } | undefined,
  defaultModel: string,
): ModelSelection {
  if (config?.provider === undefined || config.model === undefined) {
    return defaultModelSelection(defaultModel)
  }
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) },
  }
}

function summarizeApiStored(stored: {
  meta: SessionHeader
  titleEvent?: SessionEvent<'session/title'>
  lastPromptAt: number | null
  lastSeq: number
  blank: boolean
}): EdgeApiSessionSummary {
  return {
    id: stored.meta.id,
    title: stored.titleEvent === undefined
      ? null
      : foldSessionTitle([stored.titleEvent])?.title ?? null,
    createdAt: stored.meta.createdAt,
    lastPromptAt: stored.lastPromptAt,
    updatedAt: stored.lastPromptAt ?? stored.meta.createdAt,
    lastSeq: stored.lastSeq,
    blank: stored.blank,
    ...stored.meta.parentSession === undefined
      ? {}
      : { parentSessionId: stored.meta.parentSession },
    ...stored.meta.origin === undefined ? {} : { origin: stored.meta.origin },
    ...stored.meta.cwd === undefined ? {} : { cwd: stored.meta.cwd },
    ...stored.meta.agentPreset === undefined
      ? {}
      : { agentPreset: stored.meta.agentPreset },
  }
}

function summarize(header: SessionHeader, events: readonly SessionEvent[]): EdgeSession {
  const title = foldSessionTitle(events)?.title ?? null
  return {
    id: header.id,
    title,
    ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
    createdAt: header.createdAt,
    updatedAt: events.at(-1)?.time ?? header.createdAt,
  }
}

function summarizeStored(stored: {
  meta: SessionHeader
  titleEvent?: SessionEvent
  updatedAt: number
}): EdgeSession {
  return {
    id: stored.meta.id,
    title: stored.titleEvent === undefined
      ? null
      : foldSessionTitle([stored.titleEvent])?.title ?? null,
    ...stored.meta.agentPreset === undefined
      ? {}
      : { agentPreset: stored.meta.agentPreset },
    createdAt: stored.meta.createdAt,
    updatedAt: stored.updatedAt,
  }
}

export function paginateHistory(
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
): { events: SessionEvent[]; hasMore: boolean } {
  const boundedMaxMessages = Math.min(maxMessages, EDGE_HISTORY_PAGE_LIMITS.maxMessages)
  const boundaryIndex = beforeSeq === undefined
    ? -1
    : events.findIndex(event => event.seq >= beforeSeq)
  const end = boundaryIndex < 0 ? events.length : boundaryIndex
  let count = 0
  let cut = 0
  for (let index = end - 1; index >= 0; index--) {
    const event = events[index] as SessionEvent
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    const sources = (event as SessionEvent & { sourceEventSeqs?: number[] }).sourceEventSeqs
    const groupStart = sources === undefined || sources.length === 0
      ? event.seq
      : sources.reduce((minimum, value) => Math.min(minimum, value), event.seq)
    if (count >= boundedMaxMessages) {
      cut = groupStart
      break
    }
  }
  const start = cut === 0
    ? 0
    : Math.max(0, events.findIndex(event => event.seq >= cut))
  const eventCount = end - start
  if (eventCount > EDGE_HISTORY_PAGE_LIMITS.maxEvents) {
    throw new EdgeSessionStoreError(
      'INVALID_DATA',
      `History page exceeds the Edge limit of ${EDGE_HISTORY_PAGE_LIMITS.maxEvents} events.`,
    )
  }
  const page = events.slice(start, end)
  let encodedBytes = 2
  const encoder = new TextEncoder()
  for (const event of page) {
    encodedBytes += encoder.encode(JSON.stringify(event)).byteLength + 1
    if (encodedBytes > EDGE_HISTORY_PAGE_LIMITS.maxStoredBytes) {
      throw new EdgeSessionStoreError(
        'INVALID_DATA',
        `History page exceeds the Edge limit of ${EDGE_HISTORY_PAGE_LIMITS.maxStoredBytes} encoded bytes.`,
      )
    }
  }
  return {
    events: page,
    hasMore: start > 0,
  }
}

function rejectCwdConflict(requested: string | undefined, existing: string | undefined): void {
  if (requested !== undefined && existing !== requested) {
    throw new EdgeSessionCwdConflictError(requested, existing)
  }
}
