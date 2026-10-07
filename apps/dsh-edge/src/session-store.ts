/** Canonical DSH sessions backed by the upstream persistence service. */

import { EdgeSchedule } from './schedule-store.ts'
import { Context, Service as CordisService } from '@deepseek-ai/cordis'
import { installShortToolPool } from './short-tool-pool.ts'
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
import type {
  AttachmentStore,
  ImageAttachmentLimits,
  ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import { credentialRef, type CredentialInfo } from '@deepseek-ai/dsh-credentials'
import LlmRuntime, { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import MessageFeedbackService from '@deepseek-ai/dsh-message-feedback'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
  type ModelCatalogFailure,
  type ModelProviderGroup,
  type ModelReasoning,
  type SessionSearchItem,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { QueuedInboxItem, RpcId } from './edge-rpc-types.ts'
import SessionStore, {
  SessionId,
  SessionLogOffset,
  SessionPreparation,
  SESSION_FORMAT_VERSION,
  isAppendSurfaceEvent,
  type Session,
  type SessionEvent,
  type SessionEventMap,
  type SessionHeader,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import * as SessionStats from '@deepseek-ai/dsh-session-stats'
import {
  foldSessionTitle,
  normalizeSessionTitle,
} from '@deepseek-ai/dsh-session-title'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as FirstPromptTitle from '@deepseek-ai/dsh-session-title-first-prompt-llm'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import * as RepeatToolReminder from '@deepseek-ai/dsh-repeat-tool-reminder'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { assertSafeUrl } from './edge-mcp-client.ts'
import { installEdgeMcpServers, type EdgeMcpServerConfig, type McpToolManager } from './edge-mcp-manager.ts'
import type { CachedMcpTool } from './edge-mcp-tools.ts'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as ToolPresent from '@deepseek-ai/dsh-tool-present'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import GoalService from '@deepseek-ai/dsh-goal'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as CommandCompact from '@deepseek-ai/dsh-command-compact'
import * as CommandGoal from '@deepseek-ai/dsh-command-goal'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import PluginInventoryGateway from '@deepseek-ai/dsh-host-plugin-inventory'
import * as ApiRemotes from '@deepseek-ai/dsh-api-remotes'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import { EdgeTypertConnection, type TypertRpcInterceptor } from './edge-typert-connection.ts'
import EdgeFileUploadsStub from './edge-file-uploads-stub.ts'
import SessionReferenceResolver from '@deepseek-ai/dsh-session-reference'
import { EdgeFileSystem } from './edge-filesystem.ts'
import { EdgeFileReferenceService, type EdgeReferenceFiles } from './edge-file-reference.ts'
import { EdgeDirectoryPicker, type EdgeDirectoryFiles } from './edge-directory-picker.ts'
import { EdgeLoader } from './edge-plugin-loader.ts'
import * as EdgeSkillProvider from './edge-skill-provider.ts'
import type { EdgeRuntimeProviderDescriptor } from './runtime-provider.ts'
import {
  EDGE_CONTAINER_WEB_GUIDANCE,
  EDGE_PERSONA_SUFFIX,
  EDGE_PLAN_MODE_SECTION,
  edgeBashGuidance,
  edgeCurrentDate,
  edgeSystemPrompt,
  EdgeShellBindings,
  createEdgeBashTool,
  type EdgeShell,
} from './agent.ts'
import { DeepSeekFileStore } from '@deepseek-ai/dsh-llm-deepseek'
import { mountDeepSeekProvider } from './edge-llm-settings.ts'
import { DurableObjectUploadIndex } from './do-upload-index.ts'
import {
  EdgeDoAttachmentStore,
  EdgeR2AttachmentStore,
  type EdgeAttachmentStorage,
} from './edge-attachment-store.ts'
import { EdgeVfsSpillStore } from './edge-spill-store.ts'
import * as EdgeFsSearch from './edge-fs-search.ts'
import {
  type SettingsDescriptor,
  type SettingsPathOp,
} from '@deepseek-ai/dsh-settings'
import { EdgeSettings, edgeSettings, type EdgeSettingsScope } from './edge-settings.ts'
import { registerClientSettings } from './edge-client-settings.ts'
import type { WorkflowLoader } from './edge-workflow-engine.ts'
import EdgeCredentialProvider from './edge-credentials.ts'
import DurableObjectSessionPersistence, {
  EDGE_HISTORY_PAGE_LIMITS,
  type EdgeEventPage,
} from './do-session-persistence.ts'
import EdgeModelSelectionBridge from './model-selection-bridge.ts'
import EdgeSessionQuery, { edgeSearchDocuments } from './edge-session-query.ts'
import { resolveEdgeModel, upgradeLegacyDeepSeekBaseURL } from './deepseek.ts'
import type { CreateEdgeSessionInput, EdgeSession } from './protocol.ts'
import {
  normalizeAgentPreset,
  EdgeAgentPresets,
  sessionAgentPreset,
  type EdgeAgentPresetRow,
} from './agent-presets.ts'
import { installEdgeApprovalPolicy, type EdgeApprovalMode, type EdgeApprovalSettings } from './approval-policy.ts'
import { installEdgeRuntimeSettings, type EdgeRuntimeSettings } from './runtime-settings.ts'
import { installEdgeWebSearch } from './web-search.ts'
import { mountAgentLoop } from './edge-plugin-settings.ts'
import { DurableEventDeliveryQueue, ImmediateFlushLimiter } from './durable-event-delivery.ts'

const DEFAULT_WRITE_BATCH_MAX_DELAY_MS = 100
const MAX_TITLE_BYTES = 640
const MAX_MESSAGE_FEEDBACK_NOTE_BYTES = 8_192
const MAX_FORK_EVENTS = 8_192

interface EdgeSessionStoreConfig {
  readDeepSeekApiKey(): string | undefined
  searchBaseURL?: string
  attachmentStorage: EdgeAttachmentStorage
  attachmentBucket?: R2Bucket
  images?: unknown
  baseURL?: string
  model?: string
  maxTokens?: string
  reasoningEffort?: string
  streamIdleTimeoutMs?: string
  /** Worker Loader for workflow and code-run isolates; present only when the Dynamic Worker provider is available. */
  workerLoader?: WorkflowLoader
  /** The public identity of the shell serving the bash layer. */
  shell: EdgeRuntimeProviderDescriptor['shell']
  /** The deployment's bash timeout ceiling, stated to the model. */
  maxCommandTimeoutMs: number
  /** Run one bounded Computer workspace operation outside a turn (`@file` completion, directory browsing). */
  withWorkspaceFiles<T>(read: (files: EdgeWorkspaceFiles) => Promise<T>): Promise<T>
  onLateSessionEvent?: (sessionId: SessionId, event: SessionEvent) => void
  onProjectionChanged?: (sessionId: SessionId, key: string, value: unknown, seq: number) => void
  /** Called after every committed runtime-settings change, whichever API wrote it. */
  onRuntimeSettingsChanged?: () => void | Promise<void>
}

interface TurnDeliveryItem {
  event: SessionEvent
  queue: QueuedInboxItem[] | undefined
}
interface StableDeliveryQueue {
  readonly revision: number
  drain(): Promise<void>
}
interface LateDeliveryState {
  queue: DurableEventDeliveryQueue<SessionEvent>
  tail: { seq: number }
}
/** The Computer VFS surface the Edge seams drive outside an agent turn. */
export type EdgeWorkspaceFiles = EdgeReferenceFiles & EdgeDirectoryFiles
const MAX_FORK_STORED_BYTES = 8 * 1_024 * 1_024
const MAX_SEARCH_SESSIONS = 32
const MAX_SEARCH_EVENTS_PER_SESSION = 512
const MAX_SEARCH_STORED_BYTES_PER_SESSION = 256 * 1_024
const EDGE_PROVIDER = 'deepseek-official'
const EDGE_CURRENT_DATE_CONTEXT = 'edge:current-date'
const DEFAULT_EDGE_MODEL = 'deepseek-flash'
const AGENT_DEFAULT_MODEL_KEY = 'dsh-edge:agent-default-model'
const MESSAGE_TYPES = new Set<SessionEvent['type']>(['user/message', 'assistant/message'])

/** The upstream `agentDefaultModel` seam: the model new sessions start on, kept in Durable Object KV. */
export class EdgeAgentDefaultModel extends CordisService {
  private selection: ModelSelection

  constructor(
    ctx: Context,
    private readonly config: { storage: DurableObjectStorage; selection: ModelSelection },
  ) {
    super(ctx, 'agentDefaultModel')
    this.selection = { ...config.selection }
  }

  currentSelection(): ModelSelection {
    return { ...this.selection }
  }

  /** Adopt a selection only once it is durable, so a failed write keeps the prior default. */
  async saveSelection(selection: ModelSelection): Promise<void> {
    const next = { ...selection }
    await this.config.storage.put(AGENT_DEFAULT_MODEL_KEY, next)
    this.selection = next
  }
}

/** Wire-visible reason the Host cannot open a workspace path on a desktop. */
export const EDGE_NATIVE_OPEN_UNAVAILABLE = 'Native file open is not available on Cloudflare Workers; the Web client downloads the file instead.'

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
  message?: UserMessage
  mode: 'queue' | 'steer'
  content: readonly ContentBlock[]
  rpcId?: RpcId
  clientTimeZone?: string
}

export type EdgeAgentPromptAdmitter = (input: EdgeAgentPromptAdmission) => Promise<{ durable: boolean }>

export class EdgeSessionStoreError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'BUSY' | 'INVALID_DATA' | 'TITLE_INVALID' | 'FORK_UNAVAILABLE'
      | 'PRESET_UNAVAILABLE' | 'PRESET_LOCKED',
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
/** How long a turn waits for upstream's goal round driver to start a pending round (it first stores the session). */
const GOAL_ROUND_START_WAIT_MS = 30_000

export class EdgeSessionStore {
  private readonly context = new Context()
  private readonly shells = new EdgeShellBindings()
  /**
   * The owner's time zone for the current-date context: one per instance,
   * since an instance has one owner. Loaded at initialization and persisted
   * only when a prompt arrives from a different zone.
   */
  private ownerTimeZone: string | undefined
  private readonly modelSelections: EdgeModelSelectionBridge
  private readonly turnPublishedAgents = new WeakSet<Agent>()
  private readonly lateEventDeliveries = new Map<SessionId, LateDeliveryState>()
  private readonly titleFlushLimiter = new ImmediateFlushLimiter<SessionId>(DEFAULT_WRITE_BATCH_MAX_DELAY_MS)
  private readonly activeEventDeliveries = new WeakMap<Session, DurableEventDeliveryQueue<TurnDeliveryItem>>()
  private readonly unsettledEventDeliveries = new Set<StableDeliveryQueue>()
  private readonly baselineOwnedSessions = new WeakSet<Session>()
  private readonly publishesLateEvents: boolean
  private readonly residentAgents = new Map<SessionId, AgentHandle>()
  private approvalScope?: EdgeSettingsScope<EdgeApprovalSettings>
  private runtimeScope?: EdgeSettingsScope<EdgeRuntimeSettings>
  private mcpToolManager?: McpToolManager
  private readonly doStorage: DurableObjectStorage
  private readonly ready: Promise<void>

  constructor(
    storage: DurableObjectStorage,
    config: EdgeSessionStoreConfig,
  ) {
    this.doStorage = storage
    this.modelSelections = new EdgeModelSelectionBridge(storage)
    this.publishesLateEvents = config.onLateSessionEvent !== undefined
    this.ready = this.initialize(storage, config)
    // Requests observe the original rejection; early construction must not create an unhandled rejection.
    void this.ready.catch(() => undefined)
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
    await this.context.plugin(EdgeSettings, { storage })
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
    registerClientSettings(this.context)
    await this.context.plugin(LlmRuntime)
    try {
      const doUploadIndex = new DurableObjectUploadIndex(storage)
      ;(this.context as never as Record<string, unknown>)['edgeFileStore'] = new DeepSeekFileStore({ index: doUploadIndex as never })
      await mountDeepSeekProvider(this.context, buildEdgeLlmPluginConfig(config))
    } catch (error) {
      console.error('dsh-edge: LLM provider plugin failed to initialize; model operations will be unavailable.', error)
    }
    await this.context.plugin(SessionStore)
    await this.context.plugin(SessionProjectionRegistry)
    // As upstream: whole-session counts and timings, which the Web chat view
    // reads from the session's projections.
    await this.context.plugin(SessionStats)
    await this.context.plugin(SessionProjectionCache, {
      writeEveryEvents: 64,
      writeIntervalMs: 10_000,
    })
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
    await this.context.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      personaPrefix: edgeSystemPrompt(config.shell),
      personaSuffix: EDGE_PERSONA_SUFFIX,
    })
    this.context.systemPrompt.variable('workdir', ({ agent }) =>
      (agent === undefined ? undefined : this.shells.get(agent.id)?.cwd ?? agent.session.header.cwd) ?? '/workspace')
    this.context.systemPrompt.section({
      name: 'tool:bash',
      order: this.context.systemPrompt.getSectionOrder('TOOL_BASH'),
      text: edgeBashGuidance(config.maxCommandTimeoutMs),
    })
    if (config.shell === 'linux-container') {
      this.context.systemPrompt.section({
        name: 'edge:container-web',
        order: this.context.systemPrompt.getSectionOrder('TOOL_WEB_FETCH') + 1,
        text: EDGE_CONTAINER_WEB_GUIDANCE,
      })
    }
    await this.context.plugin(EdgeVfsSpillStore)
    await this.context.plugin(EdgeFileSystem)
    // As in upstream's base bundle, ahead of the file tools so it decides the
    // fs/* intents first: write may not overwrite a file this session has not
    // read, edit requires a prior read, and a file changed since it was read
    // (by bash or the Linux container, for example) fails as stale.
    await this.context.plugin(FsObservationPolicy)
    // Tools are presented natively; the PTC mode preset opts one session into
    // `run_code`, whose nested calls stay below the Workers six-connection limit.
    await this.context.plugin(ToolRuntime, config.workerLoader === undefined
      ? {}
      : { maxParallelSubCalls: 4 })
    // As in upstream's base bundle: remind the model after 3, 5, and 8 identical
    // consecutive tool calls; a new user message resets the count.
    await this.context.plugin(RepeatToolReminder)
    await this.context.plugin(SkillRegistry)
    await this.context.plugin(EdgeSkillProvider, { storage })
    await this.context.plugin(TypertRegistry)
    // The gateway installs its Remote RPC interceptor on ctx.connection; the
    // Edge seam captures it so the Durable Object can serve `$events/result`.
    await this.context.plugin(EdgeTypertConnection)
    const { TypertGatewayService } = await import('@deepseek-ai/dsh-api-gateway')
    await this.context.plugin(TypertGatewayService)
    // AgentRegistry has zero inject deps — register early so SessionController
    // finds ctx.agents when it activates.
    await this.context.plugin(AgentRegistry)
    // As in upstream's base bundle: retry a transient model-request failure
    // (rate limit, server, timeout, transport, empty response) at the failed
    // step, durably logged before each backoff. The DeepSeek provider's
    // default normal-mode policy applies: five retries, 0.5–10 s backoff.
    await this.context.plugin(LlmRetry)
    // As in upstream's base bundle: store the session log before each model
    // request, each top-level tool call, and each step, so a tool never runs
    // before its call is durable. Turn delivery alone flushes up to 100 ms later.
    await this.context.plugin(SessionCheckpointPolicy)
    // ctx.userQuestions: the upstream answerer waterfall tools and plan mode
    // ask through. The browser answers it over the forwarded `$events` stream.
    await this.context.plugin(UserQuestionService)
    // Model-facing ask_user_question over that seam; registered globally in
    // ToolRuntime like the other upstream tools, so every Edge agent mounts it.
    await this.context.plugin(ToolAskUser)
    // Upstream plan mode as-is: the logged `plan` projection, the plan:policy
    // prompt section, the exit_plan_mode tool whose review asks ctx.userQuestions,
    // and the /plan command once CommandRuntime composes below.
    await this.context.plugin(PlanModeController, { section: EDGE_PLAN_MODE_SECTION })
    await this.context.plugin(CommandRuntime)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { TYPERT: COMMANDS_TYPERT } = await import(
      '@deepseek-ai/dsh-commands/typert' as string
    )
    this.context.typert.register(COMMANDS_TYPERT as never)
    // SessionPersistence + WorkspaceRegistry before SessionController so it
    // finds ctx.workspaceRegistry on first tick.
    await this.context.plugin(DurableObjectSessionPersistence, { storage }).await()
    await this.context.plugin(MessageFeedbackService, {
      maxNoteBytes: MAX_MESSAGE_FEEDBACK_NOTE_BYTES,
    })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { TYPERT: MESSAGE_FEEDBACK_TYPERT } = await import(
      '@deepseek-ai/dsh-message-feedback/typert' as string
    )
    this.context.typert.register(MESSAGE_FEEDBACK_TYPERT as never)
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
    // The file-read controller consumes only the sandbox policy's fallback
    // workspace root. Keep this read-only adapter private to that controller;
    // it must not advertise a process-confinement policy to other plugins.
    const workspaceFilesContext = this.context.isolate('sandboxPolicy')
    workspaceFilesContext.provide('sandboxPolicy', { workspaceRoot: '/workspace' })
    const { WorkspaceFiles } = await import('@deepseek-ai/dsh-api-workspace-files')
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { TYPERT: WORKSPACE_FILES_TYPERT } = await import(
      '@deepseek-ai/dsh-api-workspace-files/typert' as string
    )
    this.context.typert.register(WORKSPACE_FILES_TYPERT as never)
    await workspaceFilesContext.plugin(WorkspaceFiles, {
      maxBytes: 1024 * 1024, maxFileBytes: 1024 * 1024, maxLines: 5000, maxEntries: 2000,
    })
    await this.context.plugin(EdgeFileUploadsStub)
    // All SessionController inject deps now available: agentDefaultModel,
    // agents, attachments, llm, sessions, sessionProjections, sessionQuery,
    // typert, workspaceRegistry. Controllers activate synchronously.
    const defaultSelection: ModelSelection = {
      provider: EDGE_PROVIDER,
      model: resolveEdgeModel(config.model),
    }
    const persistedSelection = await storage.get<ModelSelection>(AGENT_DEFAULT_MODEL_KEY)
    await this.context.plugin(EdgeAgentDefaultModel, {
      storage,
      selection: persistedSelection ?? defaultSelection,
    })
    await this.context.plugin(EdgeSessionQuery)
    // Upstream cross-session references consume ctx.sessionQuery as-is; the
    // registered TYPERT lets the gateway route sessionReferenceResolver/candidates.
    await this.context.plugin(SessionReferenceResolver)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { TYPERT: SESSION_REFERENCE_TYPERT } = await import(
      '@deepseek-ai/dsh-session-reference/typert' as string
    )
    this.context.typert.register(SESSION_REFERENCE_TYPERT as never)
    // The upstream local file-reference provider walks node:fs; the Edge serves
    // the same seam from the Computer VFS so fileReferences/list answers.
    await this.context.plugin(EdgeFileReferenceService, {
      withFiles: read => config.withWorkspaceFiles(read),
    })
    await this.context.plugin(EdgeAgentPresets, { codeRuntime: config.workerLoader !== undefined })
    // Upstream plugin inventory injects the cordis Loader. The Edge composes
    // programmatically, so EdgeLoader answers its read-only entries() from the
    // live plugin registry and the reviewed Web boot graph.
    await this.context.plugin(EdgeLoader)
    await this.context.plugin(PluginInventoryGateway)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { TYPERT: PLUGIN_INVENTORY_TYPERT } = await import(
      '@deepseek-ai/dsh-host-plugin-inventory/typert' as string
    )
    this.context.typert.register(PLUGIN_INVENTORY_TYPERT as never)
    // The upstream preset host package is not part of this deployment, so the
    // Edge registers the upstream agentPreset projection the controller and
    // browser banner read: the header, advanced by blank-session selections.
    const agentPresetSchema = {
      parse: (value: unknown): string | null => (typeof value === 'string' ? value : null),
    }
    this.context.sessionProjections.register({
      key: 'agentPreset',
      stateSchema: agentPresetSchema,
      init: (header: SessionHeader) => header.agentPreset ?? null,
      apply: (state: string | null, event: SessionEvent) =>
        event.type === 'agent-preset/selected' ? event.data.agentPreset : state,
      wire: {
        viewSchema: agentPresetSchema,
        // State may hold the legacy default id (from a header, an old
        // selection event, or a cached projection); the view reports `standard`.
        view: (state: string | null) => state === null ? null : normalizeAgentPreset(state),
      },
      stateVersion: 1,
    } as never)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { TYPERT: SESSION_CONTROLLER_TYPERT } = await import(
      '@deepseek-ai/dsh-api-session-controller/typert' as string
    )
    this.context.typert.register(SESSION_CONTROLLER_TYPERT as never)
    const { SessionController } = await import('@deepseek-ai/dsh-api-session-controller')
    // Upstream hands `session/openWorkspacePath` and its reveal/open-with
    // variants to native desktop commands (child_process.execFile). Workers
    // have no desktop, so the Edge composes the controller through its
    // `internals` seam: the native probe answers false, no applications are
    // listed, and every open attempt fails with a message the browser can
    // show, while the Edge Web client downloads the file through
    // /api/workspace/file.
    class EdgeSessionController extends SessionController {
      constructor(ctx: Context, config: ConstructorParameters<typeof SessionController>[1]) {
        const unavailable = () => Promise.reject(new Error(EDGE_NATIVE_OPEN_UNAVAILABLE))
        // activateOnFollow is added by the Edge patch to dsh-api-session-controller
        const internals = {
          activateOnFollow: false,
          openPath: unavailable,
          revealPath: unavailable,
          openFileApplication: unavailable,
          fileApplications: () => Promise.resolve([]),
          canOpenPath: () => false,
        }
        super(ctx, config, internals as never)
      }
    }
    await this.context.plugin(EdgeSessionController, { nativeOpen: false })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { TYPERT: SETTINGS_CONTROLLER_TYPERT } = await import(
      '@deepseek-ai/dsh-api-settings-controller/typert' as string
    )
    this.context.typert.register(SETTINGS_CONTROLLER_TYPERT as never)
    const { SettingsController } = await import('@deepseek-ai/dsh-api-settings-controller')
    // Upstream assumes a file-backed settings document the page can open on the
    // desktop; the Edge document lives in Durable Object storage.
    class EdgeSettingsController extends SettingsController {
      override describe() {
        return { ...super.describe(), hasDocument: false }
      }
    }
    await this.context.plugin(EdgeSettingsController)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { TYPERT: WORKSPACE_CONTROLLER_TYPERT } = await import(
      '@deepseek-ai/dsh-api-workspace-controller/typert' as string
    )
    this.context.typert.register(WORKSPACE_CONTROLLER_TYPERT as never)
    // The upstream browse picker backend walks node:fs; the Edge serves the same
    // `browse` capability from the /workspace Computer VFS so the controller's
    // directoryPicker inject resolves and the Web browse dialog answers.
    await this.context.plugin(EdgeDirectoryPicker, {
      withFiles: run => config.withWorkspaceFiles(run),
    })
    const { WorkspaceController } = await import('@deepseek-ai/dsh-api-workspace-controller')
    await this.context.plugin(WorkspaceController)
    // Upstream forwarded-event selection: api-session notifications plus the
    // Agent-scoped `user-questions/request` waterfall reach browser `$events`
    // streams through the gateway's own pending-event bookkeeping.
    await this.context.plugin(ApiRemotes)
    await this.context.plugin(ApprovalService, { policy: 'ask' })
    // Upstream runtime context becomes a durable user-role snapshot whenever
    // it changes. Edge keeps only the current date, which changes once a day,
    // and only for root sessions: a subagent gets its task from a parent that
    // knows the date. Approval is enforced by its pre-execute listener, and
    // subagent delegation context would rewrite snapshots as children start and end.
    this.ownerTimeZone = await storage.get<string>(EdgeSessionStore.OWNER_TIME_ZONE_KEY)
    this.context.systemPrompt.context({
      name: EDGE_CURRENT_DATE_CONTEXT,
      order: 100,
      text: ({ agent }) => agent === undefined || !this.context.agents.roots().includes(agent)
        ? ''
        : edgeCurrentDate(new Date(), this.ownerTimeZone),
    })
    this.context.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      return { ...assembly, contexts: assembly.contexts.filter(context => context.name === EDGE_CURRENT_DATE_CONTEXT) }
    })
    this.mcpToolManager = installEdgeMcpServers(this.context, storage)
    this.approvalScope = installEdgeApprovalPolicy(this.context, {
      resolveMcpPolicy: name => this.mcpToolManager!.resolveToolPolicy(name),
    })
    this.runtimeScope = installEdgeRuntimeSettings(this.context)
    if (config.onRuntimeSettingsChanged !== undefined) this.runtimeScope.watch(config.onRuntimeSettingsChanged)
    await this.mcpToolManager.ready
    const mcpSummary = await this.mcpToolManager.getServerSummary()
    if (mcpSummary !== undefined) {
      this.context.systemPrompt.section({ name: 'mcp-servers', order: 50, text: mcpSummary })
    }
    await this.context.plugin(ToolFs)
    // Upstream's glob and grep, run over the workspace VFS: Workers cannot
    // spawn the ripgrep binary dsh-tool-fs-search needs.
    await this.context.plugin(EdgeFsSearch)
    await this.context.plugin(ToolSkill)
    await this.context.plugin(GoalService)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { TYPERT: GOAL_TYPERT } = await import('@deepseek-ai/dsh-goal/typert' as string)
    this.context.typert.register(GOAL_TYPERT as never)
    await this.context.plugin(ToolGoal)
    // As upstream: `todo_write` keeps the session's task list; its `todos`
    // projection drives the Web client's todo dock. Several tasks may be in
    // progress, as in upstream's composition, since subagents, background
    // commands, and workflows run work in parallel.
    await this.context.plugin(ToolTodo, { allowParallelInProgress: true })
    // As upstream: `present` declares workspace files as the turn's deliverables,
    // which the Web client lists in its deliverables panel.
    await this.context.plugin(ToolPresent)
    // As upstream: load the AGENTS.md / CLAUDE.md chain from the project root
    // to the session cwd through ctx.fs (the workspace VFS), and follow file
    // tool touches into nested directories.
    await this.context.plugin(AgentInstructions, { maxBytes: 65_536, dshHome: '/.dsh' })
    await this.context.plugin(GoalRoundDriver)
    // As upstream: /compact compacts the session's history now; /goal shows,
    // sets, edits, pauses, resumes, or clears the session's goal. A command
    // that arms a goal runs inside a turn, so its rounds do too (instance.ts).
    await this.context.plugin(CommandCompact)
    await this.context.plugin(CommandGoal)
    // Upstream estimates 4 bytes per token (50,000 bytes became 12,500 tokens); keep the Edge's 32 KiB budget.
    await this.context.plugin(SpillPolicy, { maxInlineTokens: 8_192 })
    await installEdgeWebSearch(this.context, config.searchBaseURL)
    // The agent loop's parallel tool-call cap is editable on its settings card.
    await mountAgentLoop(this.context)
    installShortToolPool(this.context)
    {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { default: LocalJobRegistry } = await import(
        '@deepseek-ai/dsh-jobs-local' as string
      )
      await this.context.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 3 })
      // The Web jobs panel reads background jobs through the `job` Remote namespace.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { TYPERT: JOB_CONTROLLER_TYPERT } = await import(
        '@deepseek-ai/dsh-api-job-controller/typert' as string
      )
      this.context.typert.register(JOB_CONTROLLER_TYPERT as never)
      const { default: JobController } = await import('@deepseek-ai/dsh-api-job-controller')
      await this.context.plugin(JobController)
    }
    {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const ToolJobs = await import(
        '@deepseek-ai/dsh-tool-jobs' as string
      )
      await this.context.plugin(ToolJobs)
    }
    {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { default: SubagentRuntime } = await import(
        '@deepseek-ai/dsh-subagent' as string
      )
      await this.context.plugin(SubagentRuntime)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { TYPERT: SUBAGENT_TYPERT } = await import(
        '@deepseek-ai/dsh-subagent/typert' as string
      )
      this.context.typert.register(SUBAGENT_TYPERT as never)
    }
    {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const SpawnInProcess = await import(
        '@deepseek-ai/dsh-subagent-spawn-in-process' as string
      )
      await this.context.plugin(SpawnInProcess, { providerName: 'spawn' })
    }
    {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const ToolSubagent = await import(
        '@deepseek-ai/dsh-tool-subagent' as string
      )
      await this.context.plugin(ToolSubagent, {
        provider: 'spawn',
        maxDepth: 1,
        enableRunInBackground: true,
      })
    }
    if (config.workerLoader !== undefined) {
      // Provider-gated: each run executes in its own Dynamic Worker, so only
      // deployments with the Worker Loader binding offer the workflow tool.
      const { default: EdgeWorkflowEngine } = await import('./edge-workflow-engine.ts')
      await this.context.plugin(EdgeWorkflowEngine, { loader: config.workerLoader } as never)
      // The executor behind `run_code`; ToolRuntime reads ctx.ptcRuntime lazily.
      const { default: EdgeCodeRuntime } = await import('./edge-code-runtime.ts')
      await this.context.plugin(EdgeCodeRuntime, { loader: config.workerLoader } as never)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const ToolWorkflow = await import(
        '@deepseek-ai/dsh-tool-workflow' as string
      )
      await this.context.plugin(ToolWorkflow)
    }
    await this.context.plugin(EdgeSchedule, { storage })
    this.context.on('agent/created', ({ agent }) => {
      if (this.context.agents.roots().includes(agent)) return
      const parentId = agent.session.header.parentSession
      if (parentId === undefined) return
      const parentShell = this.shells.get(parentId)
      if (parentShell === undefined) return
      const cwd = agent.session.header.cwd ?? parentShell.cwd
      const release = this.shells.bind(agent.id, parentShell.shell, cwd)
      agent.ctx.effect(() => release, 'dsh-edge: subagent shell binding')
    })
    this.context.effect(
      () => this.context.tools.register(createEdgeBashTool(this.shells, config.shell, config.maxCommandTimeoutMs)),
      'dsh-edge: bash tool',
    )
    if (config.onLateSessionEvent !== undefined) {
      const callback = config.onLateSessionEvent
      this.context.on('session/event', (session, event) => {
        const agent = this.context.agents.get(session.id)
        if (agent?.session === session && this.turnPublishedAgents.has(agent)) return
        if (this.baselineOwnedSessions.has(session)) return
        let state = this.lateEventDeliveries.get(session.id)
        if (state === undefined) {
          const sessionId = session.id
          const tail = { seq: session.seq }
          const createdDelivery: DurableEventDeliveryQueue<SessionEvent> = new DurableEventDeliveryQueue({
            maxDelayMs: DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
            flush: async () => {
              const live = this.context.sessions.get(sessionId)
              if (live !== undefined) {
                await this.context.sessions.flush(live)
                return
              }
              // A cold mutation or short-lived child may detach before this
              // timer fires. readFrom waits for persistence retirement while
              // seeking past the tail avoids a full-log read.
              const readHandle = await this.context.sessionPersistence.open(sessionId, 'read')
              try { await readHandle.read(tail.seq) } finally { await readHandle.close() }
            },
            deliver: events => {
              for (const durableEvent of events) callback(sessionId, durableEvent)
            },
            onError: (error: unknown) => {
              console.error('dsh-edge: failed to flush late session events.', error)
            },
            onIdle: () => {
              this.unsettledEventDeliveries.delete(createdDelivery)
              if (this.lateEventDeliveries.get(sessionId)?.queue === createdDelivery) {
                this.lateEventDeliveries.delete(sessionId)
              }
            },
          })
          state = { queue: createdDelivery, tail }
          this.lateEventDeliveries.set(sessionId, state)
        }
        state.tail.seq = session.seq
        this.unsettledEventDeliveries.add(state.queue)
        // The session list reads a new title from memory before this batch is
        // durable; flush it now so a restart cannot revert a shown title (#253).
        // One immediate flush per session and window, so rapid renames, even
        // serial ones whose queue went idle between them, still coalesce.
        state.queue.enqueue(event, {
          immediate: event.type === 'session/title' && this.titleFlushLimiter.take(session.id),
        })
      })
    }
    if (config.onProjectionChanged !== undefined) {
      const projectionCallback = config.onProjectionChanged
      this.context.sessionProjections.onChanged((session, key, value, seq) => {
        projectionCallback(session.id, key, value, seq)
      })
    }
  }

  /** Non-model APIs remain available when the optional model adapter failed. */
  async waitForInitialization(): Promise<void> {
    await this.ready
  }

  /** Upgrade readiness includes the services behind the browser's live streams. */
  async assertReady(): Promise<void> {
    await this.ready
    for (const service of ['sessionPersistence', 'sessionQuery', 'workspaceRegistry',
      'sessionController', 'workspaceController', 'typertGateway']) {
      if (this.context.get(service) === undefined) throw new Error(`Required runtime service ${service} is unavailable.`)
    }
    if (!this.context.llm.listProviders().some(provider => provider.id === 'deepseek-official')) {
      throw new Error('Required model adapter is unavailable.')
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

  async skillRegistry(): Promise<SkillRegistry | undefined> {
    await this.ready
    try { return this.context.skills } catch { return undefined }
  }

  liveAgent(sessionId: SessionId): Agent | undefined {
    const { agents } = this.context
    return agents.get(sessionId)
  }

  typertGateway(): {
    invoke(request: { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<unknown>
    wireStream: {
      open(endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: undefined, signal: AbortSignal): Promise<AsyncIterable<unknown>>
      failure(error: unknown): { code: string; message: string; details: object }
    }
  } | undefined {
    try { return this.context.get('typertGateway') as never } catch { return undefined }
  }

  /** The Remote RPC interceptor the upstream gateway registered on the Edge connection seam. */
  typertRpcInterceptor(): TypertRpcInterceptor | undefined {
    try {
      return (this.context.get('connection') as EdgeTypertConnection | undefined)?.current()
    } catch {
      return undefined
    }
  }

  projectionSnapshot(sessionId: SessionId): { asOfSeq: number; values: Record<string, unknown> } | undefined {
    const agent = this.context.agents.get(sessionId)
    if (agent === undefined) return undefined
    return this.context.sessionProjections.snapshot(agent.session)
  }

  projectionCachedSnapshot(summary: { id: SessionId; createdAt: number; cwd?: string }): { asOfSeq: number; values: Record<string, unknown> } | undefined {
    const cache = this.context.get('sessionProjectionCache') as SessionProjectionCache | undefined
    if (cache === undefined) return undefined
    const session = this.context.sessions.get(summary.id)
    const header = session?.header ?? { id: summary.id, createdAt: summary.createdAt, ...summary.cwd === undefined ? {} : { cwd: summary.cwd } }
    return cache.cachedSnapshot(header as never)
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
  async modelSupportsImages(id: SessionId): Promise<boolean> {
    const selection = await this.modelSelection(id)
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
    if (live !== undefined) return referencedImage(live.snapshotEvents(), attachmentId)
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
    return edgeSettings(this.context)?.writable ?? false
  }

  /** Whether the mounted settings provider owns a user-editable file. */
  async settingsHasDocument(): Promise<boolean> {
    await this.ready
    return false
  }

  async syncMcpServer(serverName: string): Promise<{ toolCount: number }> {
    await this.ready
    if (this.mcpToolManager === undefined) throw new Error('MCP not initialized')
    const result = await this.mcpToolManager.syncServer(serverName)
    const servers = await this.doStorage.get<EdgeMcpServerConfig[]>(EdgeSessionStore.MCP_STORAGE_KEY) ?? []
    const cached = servers.find(s => s.serverName === serverName)
    return { toolCount: cached?.toolCount ?? result.tools.length }
  }

  disposeMcpServer(serverName: string): void {
    this.mcpToolManager?.disposeServer(serverName)
  }

  private static readonly MCP_PENDING_FLOW_KEY = 'dsh-edge:mcp-pending-oauth'

  async startOAuthFlow(
    serverName: string,
    serverUrl: string,
    redirectUri: string,
  ): Promise<{ authorizationUrl: string }> {
    await this.ready
    const {
      discoverEndpoints,
      registerClient,
      buildAuthorizationUrl,
    } = await import('./edge-mcp-oauth.ts')
    const endpoints = await discoverEndpoints(serverUrl)
    let client: import('./edge-mcp-oauth.ts').OAuthClient
    if (endpoints.registration !== undefined) {
      client = await registerClient(endpoints.registration, redirectUri, 'dsh-edge')
    } else {
      throw new Error('MCP server does not support Dynamic Client Registration. Provide a client ID manually.')
    }
    const { authorizationUrl, pendingFlow } = await buildAuthorizationUrl(
      endpoints, client, redirectUri, serverName, serverUrl,
    )
    await this.doStorage.put(EdgeSessionStore.MCP_PENDING_FLOW_KEY, pendingFlow)
    // Store endpoints + client on the server config for later use
    const servers = await this.doStorage.get<EdgeMcpServerConfig[]>(EdgeSessionStore.MCP_STORAGE_KEY) ?? []
    const entry = servers.find(s => s.serverName === serverName)
    if (entry !== undefined) {
      entry.auth = {
        type: 'oauth' as const,
        endpoints,
        client,
      } as never
      await this.doStorage.put(EdgeSessionStore.MCP_STORAGE_KEY, servers)
    }
    return { authorizationUrl }
  }

  async completeOAuthFlow(
    code: string,
    state: string,
  ): Promise<{ serverName: string; status: string; toolCount: number }> {
    await this.ready
    const { exchangeCode } = await import('./edge-mcp-oauth.ts')
    const pending = await this.doStorage.get<import('./edge-mcp-oauth.ts').PendingOAuthFlow>(
      EdgeSessionStore.MCP_PENDING_FLOW_KEY,
    )
    if (pending === undefined || pending.state !== state) {
      throw new Error('Invalid or expired OAuth state. Try connecting again.')
    }
    // Burn the pending flow (single-use)
    await this.doStorage.delete(EdgeSessionStore.MCP_PENDING_FLOW_KEY)

    const servers = await this.doStorage.get<EdgeMcpServerConfig[]>(EdgeSessionStore.MCP_STORAGE_KEY) ?? []
    const entry = servers.find(s => s.serverName === pending.serverName)
    if (entry !== undefined && pending.serverUrl !== undefined && entry.url !== pending.serverUrl) {
      throw new Error('Server URL changed during OAuth flow. Try connecting again.')
    }
    const oauthAuth = entry?.auth as { type: string; endpoints?: { token?: string }; client?: { clientId: string; clientSecret?: string } } | undefined
    if (oauthAuth?.type !== 'oauth' || oauthAuth.endpoints?.token === undefined || oauthAuth.client === undefined) {
      throw new Error('OAuth config not found for this server.')
    }

    const client = pending.stagedClient ?? oauthAuth.client
    const tokens = await exchangeCode(
      oauthAuth.endpoints.token,
      client,
      code,
      pending.codeVerifier,
      pending.redirectUri,
      pending.serverUrl,
    )

    // Store tokens via credential provider
    await this.context.credentials.set(
      this.mcpCredentialRef(pending.serverName),
      tokens.accessToken,
    )
    // Always replace refresh metadata — clears stale expiry from prior flows
    const refreshKey = `dsh-edge:mcp-refresh:${pending.serverName}`
    if (tokens.refreshToken !== undefined || tokens.expiresAt !== undefined) {
      await this.doStorage.put(refreshKey, {
        refreshToken: tokens.refreshToken ?? '',
        expiresAt: tokens.expiresAt,
        tokenEndpoint: oauthAuth.endpoints.token,
        client,
        serverUrl: pending.serverUrl,
      })
    } else {
      await this.doStorage.delete(refreshKey)
    }

    // Auto-probe + hot-swap now that we have a token
    try {
      await this.syncMcpServer(pending.serverName)
    } catch (probeError) {
      console.error(`dsh-edge: post-OAuth probe failed for "${pending.serverName}".`, probeError)
    }

    const updatedServers = await this.doStorage.get<EdgeMcpServerConfig[]>(EdgeSessionStore.MCP_STORAGE_KEY) ?? []
    const updated = updatedServers.find(s => s.serverName === pending.serverName)
    return { serverName: pending.serverName, status: updated?.status ?? 'connected', toolCount: updated?.toolCount ?? 0 }
  }

  async getApprovalMode(): Promise<EdgeApprovalMode> {
    await this.ready
    return this.approvalScope?.get().mode ?? 'ask'
  }

  async setApprovalMode(mode: EdgeApprovalMode): Promise<void> {
    await this.ready
    if (mode !== 'ask' && mode !== 'never') throw new Error('Invalid approval mode.')
    await this.approvalScope?.update({ mode })
  }

  /** Record the zone of the owner's latest prompt; a change is written once. */
  async noteOwnerTimeZone(timeZone: string): Promise<void> {
    await this.ready
    if (this.ownerTimeZone === timeZone) return
    // Durable first: memory never runs ahead of what a restart reloads.
    await this.doStorage.put(EdgeSessionStore.OWNER_TIME_ZONE_KEY, timeZone)
    this.ownerTimeZone = timeZone
  }

  /**
   * Current runtime settings. Only valid after {@link waitForInitialization}:
   * reading earlier would silently apply defaults instead of the saved values.
   */
  runtimeSettings(): EdgeRuntimeSettings {
    if (this.runtimeScope === undefined) throw new Error('Runtime settings were read before initialization.')
    return this.runtimeScope.get()
  }

  async updateRuntimeSettings(patch: Partial<EdgeRuntimeSettings>): Promise<EdgeRuntimeSettings> {
    await this.ready
    await this.runtimeScope!.update(patch)
    return this.runtimeSettings()
  }

  private static readonly OWNER_TIME_ZONE_KEY = 'dsh-edge:owner-time-zone'
  private static readonly MCP_STORAGE_KEY = 'dsh-edge:mcp-servers'
  private static readonly MCP_TOOLS_PREFIX = 'dsh-edge:mcp-tools:'

  async getMcpServers(): Promise<EdgeMcpServerConfig[]> {
    await this.ready
    const raw = await this.doStorage.get<EdgeMcpServerConfig[]>(
      EdgeSessionStore.MCP_STORAGE_KEY,
    )
    if (!Array.isArray(raw)) return []
    return raw.map(s => {
      const auth = s.auth as { type: string; endpoints?: unknown; client?: { clientId: string; clientSecret?: string } } | undefined
      if (auth?.type === 'oauth' && auth.client?.clientSecret !== undefined) {
        return { ...s, auth: { type: 'oauth' as const, endpoints: auth.endpoints, client: { clientId: auth.client.clientId } } }
      }
      return s
    })
  }

  async getMcpTools(serverName: string): Promise<CachedMcpTool[]> {
    await this.ready
    return await this.doStorage.get<CachedMcpTool[]>(EdgeSessionStore.MCP_TOOLS_PREFIX + serverName) ?? []
  }

  async setMcpServers(servers: Partial<EdgeMcpServerConfig>[]): Promise<void> {
    await this.ready
    const oldServers = await this.doStorage.get<EdgeMcpServerConfig[]>(EdgeSessionStore.MCP_STORAGE_KEY) ?? []
    const seen = new Set<string>()
    const validated = servers.map(s => {
      if (typeof s.serverName !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/u.test(s.serverName)) {
        throw new Error('serverName must match [A-Za-z0-9_-]{1,32}.')
      }
      if (seen.has(s.serverName)) {
        throw new Error(`Duplicate serverName "${s.serverName}".`)
      }
      seen.add(s.serverName)
      if (typeof s.url !== 'string') {
        throw new Error('url is required.')
      }
      let parsed: URL
      try { parsed = new URL(s.url) } catch {
        throw new Error('url must be a valid HTTP(S) URL.')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('url must use http: or https: protocol.')
      }
      if (parsed.username.length > 0 || parsed.password.length > 0) {
        throw new Error('url must not contain credentials; use the credential provider.')
      }
      assertSafeUrl(s.url)
      if (s.toolCallTimeoutMs !== undefined
        && (typeof s.toolCallTimeoutMs !== 'number' || !Number.isFinite(s.toolCallTimeoutMs) || s.toolCallTimeoutMs <= 0)) {
        throw new Error('toolCallTimeoutMs must be a positive number.')
      }
      if (s.auth !== undefined && s.auth.type !== 'none' && s.auth.type !== 'bearer' && s.auth.type !== 'oauth') {
        throw new Error('Supported auth types: "none", "bearer", "oauth".')
      }
      const tp = (s as { toolPolicy?: { mode?: string } }).toolPolicy
      if (tp !== undefined && (typeof tp !== 'object' || (tp.mode !== 'allow_all' && tp.mode !== 'read_only' && tp.mode !== 'approve_all'))) {
        throw new Error('Supported toolPolicy modes: "allow_all", "read_only", "approve_all".')
      }
      return {
        serverName: s.serverName,
        url: s.url,
        auth: s.auth?.type === 'oauth' ? { type: 'oauth' as const }
          : s.auth?.type === 'bearer' ? { type: 'bearer' as const }
          : { type: 'none' as const },
        ...(s.toolCallTimeoutMs !== undefined ? { toolCallTimeoutMs: s.toolCallTimeoutMs } : {}),
        ...(tp?.mode !== undefined ? { toolPolicy: { mode: tp.mode as 'allow_all' | 'read_only' | 'approve_all' } } : {}),
      }
    })
    // Preserve status/toolCount/serverInfo for servers whose name+url+auth.type are unchanged
    const oldByName = new Map(oldServers.map(s => [s.serverName, s]))
    for (const v of validated) {
      const old = oldByName.get(v.serverName)
      if (old !== undefined && old.url === v.url && old.auth?.type === v.auth?.type) {
        (v as EdgeMcpServerConfig).status = old.status;
        (v as EdgeMcpServerConfig).toolCount = old.toolCount;
        (v as EdgeMcpServerConfig).lastProbeAt = old.lastProbeAt;
        (v as EdgeMcpServerConfig).serverInfo = old.serverInfo;
        (v as EdgeMcpServerConfig).instructions = old.instructions;
        (v as EdgeMcpServerConfig).lastError = old.lastError
        if (v.toolPolicy === undefined && old.toolPolicy !== undefined) {
          (v as EdgeMcpServerConfig).toolPolicy = old.toolPolicy
        }
      }
    }
    await this.doStorage.put(EdgeSessionStore.MCP_STORAGE_KEY, validated)
    this.mcpToolManager?.invalidateConfigCache()
    // Dispose tools and clear credentials/tools for removed or changed servers
    const newByName = new Map(validated.map(s => [s.serverName, s]))
    for (const old of oldServers) {
      const replacement = newByName.get(old.serverName)
      const changed = replacement === undefined || replacement.url !== old.url || replacement.auth?.type !== old.auth?.type
      if (changed) {
        this.disposeMcpServer(old.serverName)
        await this.doStorage.delete(EdgeSessionStore.MCP_TOOLS_PREFIX + old.serverName).catch(() => {})
        if (old.auth?.type === 'bearer' || old.auth?.type === 'oauth') {
          await this.context.credentials.unset(this.mcpCredentialRef(old.serverName)).catch(() => {})
          await this.doStorage.delete(`dsh-edge:mcp-refresh:${old.serverName}`).catch(() => {})
        }
      }
    }
  }

  private mcpCredentialRef(serverName: string) {
    return credentialRef(`MCP_TOKEN_${serverName.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`)
  }

  async setMcpToken(serverName: string, token: string): Promise<void> {
    await this.ready
    await this.context.credentials.set(this.mcpCredentialRef(serverName), token)
  }

  async clearMcpToken(serverName: string): Promise<void> {
    await this.ready
    await this.context.credentials.unset(this.mcpCredentialRef(serverName))
  }

  async resolveMcpToken(serverName: string): Promise<string | undefined> {
    await this.ready
    const resolved = await this.context.credentials.resolve(this.mcpCredentialRef(serverName))
    return resolved?.value
  }

  /** Describe all registered settings namespaces with redacted secrets. */
  async describeSettings(): Promise<SettingsDescriptor[]> {
    await this.ready
    return edgeSettings(this.context)?.describe({ redactSecrets: true }) ?? []
  }

  /** Merge a patch into one namespace's user section. */
  async updateSettings(
    ns: string,
    patch: object,
    expectedRevision?: number,
  ): Promise<SettingsDescriptor | undefined> {
    await this.ready
    await edgeSettings(this.context).update(ns, patch, expectedRevision)
    return edgeSettings(this.context).describe({ redactSecrets: true })
      .find(d => (d.ns as string) === ns)
  }

  /** Replace one namespace's user section wholesale. */
  async replaceSettings(
    ns: string,
    section: object,
    expectedRevision?: number,
  ): Promise<SettingsDescriptor | undefined> {
    await this.ready
    await edgeSettings(this.context).replace(ns, section, expectedRevision)
    return edgeSettings(this.context).describe({ redactSecrets: true })
      .find(d => (d.ns as string) === ns)
  }

  /** Apply path-addressed edits to one namespace's user section. */
  async mutateSettings(
    ns: string,
    ops: readonly SettingsPathOp[],
    expectedRevision?: number,
  ): Promise<SettingsDescriptor | undefined> {
    await this.ready
    await edgeSettings(this.context).mutate(ns, ops, expectedRevision)
    return edgeSettings(this.context).describe({ redactSecrets: true })
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

  private agentDefaultModel(): EdgeAgentDefaultModel {
    return this.context.get('agentDefaultModel') as EdgeAgentDefaultModel
  }

  /**
   * The selection a session without one of its own starts on: as upstream,
   * the owner's latest pick in any session, else the deployment model.
   */
  private defaultModelSelection(): ModelSelection {
    return this.agentDefaultModel().currentSelection()
  }

  /** Resolve the selection using the same pending → logged → default order as upstream ApiProxy. */
  async modelSelection(id: SessionId): Promise<ModelSelection> {
    const { sessions, persistence } = await this.services()
    // A live agent adopted from the upstream SessionController consumes the
    // agent-layer pending selection on its next request, so that selection
    // wins over the Edge bridge for admission checks.
    const agentPending = this.agentPendingSelection(id)
    if (agentPending !== undefined) return agentPending
    const pending = await this.loadModelSelection(id)
    if (pending !== undefined) return pending
    const live = sessions.get(id)
    if (live !== undefined) return loggedModelSelection(live.requestHeader()?.config, this.defaultModelSelection())
    if (!(persistence instanceof DurableObjectSessionPersistence)) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Edge persistence backend is unavailable.')
    }
    if (persistence.readBlankSession(id) !== undefined) return this.defaultModelSelection()
    if (persistence.readSessionHeader(id) === undefined) {
      throw new EdgeSessionStoreError('NOT_FOUND', 'Session not found.')
    }
    return loggedModelSelection(persistence.readLatestModelSelection(id), this.defaultModelSelection())
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
    // As upstream, the latest pick also becomes the default for new sessions.
    await this.agentDefaultModel().saveSelection(selected).catch((error: unknown) => {
      console.warn('dsh-edge: model selection changed for the session but the default was not saved.', error)
    })
    // Publish the upstream durable projection even when no Agent is resident.
    const { sessions, persistence } = await this.services()
    const live = sessions.get(id)
    if (live !== undefined) {
      live.append('model/selection', selected)
      await sessions.flush(live)
    } else {
      await using handle = await persistence.open(id, 'write')
      const coldRead = await handle.read()
      using preparation = SessionPreparation.create(sessions.prepare(id, {
        seed: [...coldRead.events],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: coldRead.eventState,
      }))
      // Session construction can append session/end-seed before event routing
      // starts. Persist that suffix before publishing any subsequent mutation.
      await handle.append(preparation.session.snapshotEvents(SessionLogOffset(coldRead.events.length)))
      const detach = sessions.enter(preparation.session)
      try {
        sessions.announce(preparation.session)
        preparation.session.append('model/selection', selected)
        await sessions.flush(preparation.session)
      } finally { detach() }
    }
    return selected
  }

  private async sessionContainsImages(id: SessionId): Promise<boolean> {
    const { agents, sessions, persistence } = await this.services()
    const agent = agents.get(id)
    if (agent !== undefined && [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
      .some(message => message.content.some(block => block.type === 'image'))) return true
    const live = sessions.get(id)
    if (live !== undefined) return appendSurfaceContainsImage(live.snapshotEvents())
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
          if (event.type === 'agent/inbox/spliced') {
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
    const { agents, sessions } = await this.services()
    const title = normalizeSessionTitle(input.title, MAX_TITLE_BYTES)
    if (title.length === 0) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Session title must contain visible text.')
    }
    const id = SessionId(crypto.randomUUID())
    const handle = await agents.create({
      sessionId: id,
      meta: {
        cwd: input.cwd ?? '/workspace',
        agentPreset: (this.context.get('agentPresets') as EdgeAgentPresets).defaultPreset(),
      },
      agentOptions: { provider: EDGE_PROVIDER, model: DEFAULT_EDGE_MODEL },
      setup: (agentCtx, agent) => this.composeAgent(agentCtx, agent),
    })
    const { agent } = handle
    const { session } = agent
    this.baselineOwnedSessions.add(session)
    try {
      session.append('session/title', {
        title,
        messageSeqs: [],
        source: { kind: 'user' },
      })
      await sessions.flush(session)
      return summarize(session.header, session.snapshotEvents())
    } finally {
      this.baselineOwnedSessions.delete(session)
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
    agentPreset?: string
  }): Promise<{ sessionId: SessionId; agentPreset: string; created: boolean }> {
    const { sessions, persistence } = await this.services()
    const id = input.sessionId ?? SessionId(`session-${crypto.randomUUID()}`)
    const sessionCwd = input.cwd ?? '/workspace'
    const attached = sessions.get(id)
    if (attached !== undefined) {
      rejectCwdConflict(input.cwd, attached.header.cwd)
      return {
        sessionId: id,
        agentPreset: sessionAgentPreset(attached.header),
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
        agentPreset: sessionAgentPreset(stored.meta),
        created: false,
      }
    }
    const retainedBlank = persistence.readBlankSession(id)
    if (retainedBlank !== undefined) {
      rejectCwdConflict(input.cwd, retainedBlank.cwd)
      return {
        sessionId: id,
        agentPreset: sessionAgentPreset(retainedBlank),
        created: false,
      }
    }
    // Availability applies to new sessions only: an existing one (a retry or
    // restore) keeps the preset its header recorded, even if no longer offered.
    const presets = this.context.get('agentPresets') as EdgeAgentPresets
    const agentPreset = normalizeAgentPreset(input.agentPreset ?? presets.defaultPreset())
    if (!presets.offers(agentPreset)) {
      throw new EdgeSessionStoreError('PRESET_UNAVAILABLE', `Agent preset "${agentPreset}" is not available.`)
    }
    await persistence.retainBlankSession({
      id, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), isSeeded: false,
      cwd: sessionCwd, agentPreset,
    })
    await persistence.materializeBlankSession(id)
    return { sessionId: id, agentPreset, created: true }
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
    if (live !== undefined) return summarizeApiLive(live.header, live.snapshotEvents())
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
        if (live.snapshotEvents().length > MAX_SEARCH_EVENTS_PER_SESSION) {
          hasMore = true
          continue
        }
        events = live.snapshotEvents()
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
      const match = edgeSearchDocuments(summary.id, events)
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

    while (true) {
      const snapshot = () => {
        const liveSessions = sessions.list()
        const deliveries = [...this.unsettledEventDeliveries]
          .map(queue => ({ queue, revision: queue.revision }))
        return { liveSessions, deliveries }
      }

      const before = snapshot()
      await Promise.all(before.deliveries.map(({ queue }) => queue.drain()))
      const after = snapshot()
      const stableSessions = before.liveSessions.length === after.liveSessions.length
        && before.liveSessions.every((session, index) => session === after.liveSessions[index])
      const stableDeliveries = before.deliveries.length === after.deliveries.length
        && before.deliveries.every(({ queue, revision }, index) => {
          const current = after.deliveries[index]
          return current?.queue === queue && current.revision === revision
        })
      if (!stableSessions || !stableDeliveries) continue

      for (const { queue } of after.deliveries) this.unsettledEventDeliveries.delete(queue)
      const queues: EdgeMuxBaseline['queues'] = []
      for (const session of after.liveSessions) {
        const agent = agents.get(session.id)
        if (agent?.session !== session || (agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0)) continue
        queues.push({ sessionId: session.id, items: queueItems(agent) })
      }
      return consume({ sessions: collectApiSessions(sessions, persistence), queues })
    }
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
      const page = paginateHistory(live.snapshotEvents(), beforeSeq, boundedMaxMessages)
      return {
        summary: summarizeApiLive(live.header, live.snapshotEvents()),
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
      events = live.snapshotEvents()
    } else {
      const blank = persistence.readBlankSession(id)
      if (blank !== undefined) {
        header = blank
        events = []
        return await this.createForkedSession(agents, sessions, id, header, events, atSeq, model)
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
    return await this.createForkedSession(agents, sessions, id, header, events, atSeq, model)
  }

  private async createForkedSession(
    agents: AgentRegistry,
    sessions: SessionStore,
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
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: {
        ...header.cwd === undefined ? {} : { cwd: header.cwd },
        parentSession: id,
        isSeeded: seed.length > 0,
        agentPreset: sessionAgentPreset(header),
      },
      agentOptions: { provider: EDGE_PROVIDER, model },
      setup: (agentCtx, agent) => this.composeAgent(agentCtx, agent),
    })
    try {
      await sessions.flush(handle.agent.session)
      return summarizeApiLive(handle.agent.session.header, handle.agent.session.snapshotEvents())
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
    if (live !== undefined) {
      const publishRequired = !this.turnPublishedAgents.has(live) && !this.publishesLateEvents
      return { title: normalized, event: appendUserTitle(live, normalized), publishRequired }
    }

    const handle = await this.getOrResumeAgent(id, model)
    return {
      title: normalized,
      event: appendUserTitle(handle.agent, normalized),
      publishRequired: !this.publishesLateEvents,
    }
  }

  /** Count live Agent owners for host.describe. */
  async attachedSessionCount(): Promise<number> {
    const { agents } = await this.services()
    return agents.list().length
  }

  /**
   * Return a resident agent for the session, resuming from persistence on
   * first access within this DO activation. The agent stays alive across
   * turns in idle phase; only session deletion or DO shutdown disposes it.
   */
  async getOrResumeAgent(id: SessionId, model: string): Promise<AgentHandle> {
    const cached = this.residentAgents.get(id)
    if (cached !== undefined) {
      await this.loadModelSelection(id)
      return cached
    }
    const { agents, persistence } = await this.services()
    await this.loadModelSelection(id)
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
      setup: (agentCtx, agent) => this.composeAgent(agentCtx, agent),
    })
    try {
      await this.context.sessions.flush(handle.agent.session)
      this.residentAgents.set(id, handle)
      return handle
    } catch (error) {
      await handle.dispose().catch((disposeError: unknown) => {
        console.error('dsh-edge failed to roll back agent resume.', disposeError)
      })
      throw error
    }
  }

  /** Dispose a resident agent and remove it from the cache. */
  async disposeResidentAgent(id: SessionId): Promise<void> {
    const handle = this.residentAgents.get(id)
    if (handle === undefined) return
    this.residentAgents.delete(id)
    await handle.dispose()
  }

  /** @deprecated Use getOrResumeAgent for resident lifecycle. */
  async openAgentForTurn(id: SessionId, model: string): Promise<AgentHandle> {
    return this.getOrResumeAgent(id, model)
  }

  /** Compose one Agent from its session's preset and model selection before it is published. */
  private composeAgent(agentCtx: Context, agent: Agent): void {
    const presets = this.context.get('agentPresets') as EdgeAgentPresets
    presets.join(agentCtx, sessionAgentPreset(agent.session.header))
    this.installAgentModelSelection(agentCtx, agent)
  }

  /** The agent presets this deployment offers, default first. */
  async agentPresetRows(): Promise<EdgeAgentPresetRow[]> {
    await this.services()
    return (this.context.get('agentPresets') as EdgeAgentPresets).rows()
  }

  /**
   * Record a blank session's preset before its first turn, as upstream does:
   * an `agent-preset/selected` event, persisted in the same transaction that
   * rewrites the durable header. The resident agent (and its live copy of the
   * old header) was composed from the previous preset, so it is released and
   * the next turn resumes under the selected one.
   */
  async selectAgentPreset(id: SessionId, requested: string, model: string): Promise<string> {
    const agentPreset = normalizeAgentPreset(requested)
    const presets = this.context.get('agentPresets') as EdgeAgentPresets
    if (!presets.offers(agentPreset)) {
      throw new EdgeSessionStoreError('PRESET_UNAVAILABLE', `Agent preset "${agentPreset}" is not available.`)
    }
    const { session } = (await this.getOrResumeAgent(id, model)).agent
    const events = session.snapshotEvents()
    if (events.some(event => event.type === 'turn/start')) {
      throw new EdgeSessionStoreError('PRESET_LOCKED', `Session ${id} has already started; its agent preset is fixed.`)
    }
    if (sessionAgentPreset(session.header) === agentPreset) return agentPreset
    session.append('agent-preset/selected', { agentPreset })
    await this.context.sessions.flush(session)
    // The selection is durable; a teardown failure must not report it as refused.
    await this.disposeResidentAgent(id).catch((disposeError: unknown) => {
      console.error('dsh-edge failed to release the agent after a preset selection.', disposeError)
    })
    return agentPreset
  }

  /** Mount the upstream per-agent selection seam before the Agent is published. */
  private installAgentModelSelection(agentCtx: Context, agent: Agent): void {
    let assembled: ModelSelection | undefined
    const selections = this.modelSelections
    const defaultSelection = () => this.defaultModelSelection()
    const selection: ModelSelectionRef = {
      get current() {
        return selections.current(agent.id)
          ?? loggedModelSelection(agent.session.requestHeader()?.config, defaultSelection())
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

  /** Read the agent-layer pending selection installed by the SessionController. */
  private agentPendingSelection(id: SessionId): ModelSelection | undefined {
    const agent = this.context.agents.get(id)
    if (agent === undefined) return undefined
    try {
      const state = this.context.sessionProjections.stateOf(agent.session, 'modelSelection') as {
        pending?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
      } | undefined
      const pending = state?.pending
      if (pending == null
        || typeof pending.provider !== 'string'
        || typeof pending.model !== 'string') return undefined
      const selection: ModelSelection = { provider: pending.provider, model: pending.model }
      return typeof pending.reasoningEffort === 'string'
        ? {
          ...selection,
          reasoningEffort: pending.reasoningEffort as NonNullable<ModelSelection['reasoningEffort']>,
        }
        : selection
    } catch {
      return undefined
    }
  }

  /** Retire the Edge bridge after the matching upstream request header is durable. */
  private async retireLoggedModelSelection(agent: Agent): Promise<void> {
    const config = agent.session.requestHeader()?.config
    if (config?.provider === undefined || config.model === undefined) return
    await this.modelSelections.clearIfLogged(
      agent.id,
      loggedModelSelection(config, this.defaultModelSelection()),
    )
  }

  /** Drive one turn through ReactLoopAgent and publish only durable events. */
  async runAgentTurn(input: {
    message?: UserMessage
    agent: Agent
    mode: 'queue' | 'steer'
    content: readonly ContentBlock[]
    rpcId?: RpcId
    clientTimeZone?: string
    shell: EdgeShell
    publish: (event: SessionEvent) => void | Promise<void>
    publishQueue?: (items: QueuedInboxItem[]) => void | Promise<void>
    /** Runs as a turn starts, before its events are durable and published; follow streams can already observe it. */
    onTurnStart?: (seq: number) => void
    afterFollowup?: () => void
    onAdmitted?: (admit: EdgeAgentPromptAdmitter) => void
    onClosing?: () => void
    /**
     * Runs in place of admitting `content`, inside this turn's workspace scope
     * and event delivery: an agent-scoped call (resuming a goal, a command)
     * whose effects may start the agent. The turn then lasts until the agent
     * is idle with no goal round pending.
     */
    start?: () => Promise<void>
  }): Promise<void> {
    const { sessions } = await this.services()
    const { agent } = input
    if (this.context.agents.get(agent.id) !== agent || sessions.get(agent.id) !== agent.session) {
      throw new EdgeSessionStoreError('INVALID_DATA', 'Agent is not the live persistence owner.')
    }

    if (this.shells.get(agent.id) === undefined) {
      this.shells.bind(agent.id, input.shell, agent.session.header.cwd ?? '/workspace')
    }
    const priorDelivery = this.lateEventDeliveries.get(agent.id)?.queue.drain()
      ?? Promise.resolve()
    void priorDelivery.catch(() => {})
    let deliveryError: unknown
    const delivery: DurableEventDeliveryQueue<TurnDeliveryItem> = new DurableEventDeliveryQueue({
      maxDelayMs: DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
      flush: async () => {
        await priorDelivery
        await sessions.flush(agent.session)
      },
      deliver: async items => {
        for (const item of items) {
          if (deliveryError !== undefined) return
          try {
            await input.publish(item.event)
            if (item.queue !== undefined) await input.publishQueue?.(item.queue)
          } catch (error) {
            deliveryError = error
          }
        }
      },
      onIdle: () => { this.unsettledEventDeliveries.delete(delivery) },
    })
    const stopObserving = this.context.on('session/event', (subject, event) => {
      if (subject !== agent.session) return
      if (event.type === 'turn/start') input.onTurnStart?.(event.seq)
      const queue = event.type === 'agent/inbox/spliced'
        ? queueItems(agent, event.data)
        : undefined
      this.unsettledEventDeliveries.add(delivery)
      delivery.enqueue({ event, queue })
    })
    this.activeEventDeliveries.set(agent.session, delivery)
    this.turnPublishedAgents.add(agent)
    const admission = createDurablePromptAdmitter(
      this.context,
      agent,
      () => sessions.flush(agent.session),
    )

    try {
      if (input.start === undefined) {
        const admitted = admission.admit({
          ...input.message === undefined ? {} : { message: input.message },
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
      } else {
        await input.start()
        if (agent.status !== 'idle' || this.goalRoundPending(agent)) input.onAdmitted?.(admission.admit)
      }
      while (true) {
        await agent.whenIdle()
        if (agent.status !== 'idle') continue
        // Upstream's goal round driver queues the next round once the agent
        // is idle. Keep the turn open for it, so every round runs in this
        // turn's workspace scope, deadline, and event delivery.
        if (this.goalRoundPending(agent) && await this.goalRoundStarted(agent)) continue
        input.onClosing?.()
        break
      }
      await delivery.drain()
      await sessions.flush(agent.session)
      await this.retireLoggedModelSelection(agent).catch((error: unknown) => {
        // A retained matching bridge is harmless and can be retried after the next turn.
        console.error('dsh-edge failed to retire a logged model selection.', error)
      })
    } finally {
      await priorDelivery.catch(() => {})
      await delivery.drain().catch(() => {})
      await agent.whenIdle().catch(() => {})
      admission.dispose()
      stopObserving()
      if (this.activeEventDeliveries.get(agent.session) === delivery) {
        this.activeEventDeliveries.delete(agent.session)
      }
      this.turnPublishedAgents.delete(agent)
    }
  }

  /**
   * Stop a turn's work as upstream's goal round driver expects. While the
   * agent runs, cancel it: the driver then pauses a goal whose round was
   * underway (a durable `goal/change`), and disarms one whose turn was not a
   * round. Between rounds the agent is idle and cancelling is a no-op, so
   * disarm the goal instead: it stays active, records no event, and resumes
   * on the owner's request, as upstream's lifecycle owners do before
   * unloading the driver.
   */
  stopAgentWork(agent: Agent): void {
    if (agent.status !== 'idle') {
      agent.cancel({ kind: 'user' })
      return
    }
    this.disarmGoal(agent)
  }

  private disarmGoal(agent: Agent): void {
    if (this.context.agents.get(agent.id) !== agent) return
    try {
      if (this.context.goals.get(agent)?.activation === 'armed') this.context.goals.disarm(agent)
    } catch (error) {
      console.warn('dsh-edge: could not disarm a goal.', error)
    }
  }

  /** Whether upstream's goal round driver is about to queue a round for this agent. */
  private goalRoundPending(agent: Agent): boolean {
    if (this.context.agents.get(agent.id) !== agent) return false
    try {
      const goal = this.context.goals.get(agent)
      return goal !== undefined && goal.phase === 'active' && goal.activation === 'armed'
        && goal.roundsStarted < goal.maxGoalRounds
    } catch {
      return false
    }
  }

  /**
   * Wait for the pending goal round to start the agent. Resolves false when
   * the goal stops being pending first, or when the driver does not start the
   * round within GOAL_ROUND_START_WAIT_MS, in which case the goal is disarmed.
   */
  private goalRoundStarted(agent: Agent): Promise<boolean> {
    return new Promise(resolve => {
      const disposers: (() => void)[] = []
      const timer = setTimeout(() => {
        // The turn ends, so the round must not start later outside it: the
        // driver checks the goal is still armed before it queues the round.
        console.warn('dsh-edge: a pending goal round did not start; its goal is disarmed and the turn ends.')
        this.disarmGoal(agent)
        finish(false)
      }, GOAL_ROUND_START_WAIT_MS)
      const settle = () => {
        if (agent.status !== 'idle') return finish(true)
        if (!this.goalRoundPending(agent)) return finish(false)
      }
      const finish = (started: boolean) => {
        clearTimeout(timer)
        for (const dispose of disposers.splice(0)) dispose()
        resolve(started)
      }
      disposers.push(
        this.context.on('agent/status', ({ agent: subject }) => { if (subject === agent) settle() }),
        this.context.on('goal/activation-changed', ({ sessionId }) => { if (sessionId === agent.id) settle() }),
        this.context.on('session/event', (session, event) => { if (session === agent.session && event.type === 'goal/change') settle() }),
      )
      settle()
    })
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
    if ((event.type as string) === 'assistant/chunk' && isRecord(data.chunk)
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
    const message = prompt.message ?? createUserMessage({
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
      return { durable: true }
    } catch {
      // The inbox mutation already woke the driver, so this prompt remains
      // accepted. Reject model-visible consumption; the turn's delivery
      // barrier reports the persistence failure through host/agent-error.
      gate.resolve(false)
      return { durable: false }
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
    summaries.set(session.id, summarizeApiLive(session.header, session.snapshotEvents()))
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
    ...header.agentPreset === undefined ? {} : { agentPreset: normalizeAgentPreset(header.agentPreset) },
  }
}

function buildEdgeLlmPluginConfig(config: EdgeSessionStoreConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (config.baseURL !== undefined) out['baseURL'] = upgradeLegacyDeepSeekBaseURL(config.baseURL)
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

/** Rebuild the session-local selection from its latest full request header. */
function loggedModelSelection(
  config: { provider?: string; model?: string; reasoningEffort?: string } | undefined,
  fallback: ModelSelection,
): ModelSelection {
  if (config?.provider === undefined || config.model === undefined) return fallback
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
      : { agentPreset: normalizeAgentPreset(stored.meta.agentPreset) },
  }
}

function summarize(header: SessionHeader, events: readonly SessionEvent[]): EdgeSession {
  const title = foldSessionTitle(events)?.title ?? null
  return {
    id: header.id,
    title,
    ...header.agentPreset === undefined ? {} : { agentPreset: normalizeAgentPreset(header.agentPreset) },
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
      : { agentPreset: normalizeAgentPreset(stored.meta.agentPreset) },
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
      : sources.reduce((minimum, value) => Math.min(minimum, value), event.seq as number)
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

/** The pinned upstream teardown detaches Agent/Session even when it rejects. */
export async function disposeAgentHandle(handle: AgentHandle, released: () => void): Promise<void> {
  try { await handle.dispose() }
  finally { released() }
}
