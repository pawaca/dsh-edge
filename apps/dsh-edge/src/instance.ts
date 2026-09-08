/** Workspace Durable Object with persistent sessions and streamed agent turns. */

import { initializeSchedules, nextSchedule, scheduleWakeTime } from './schedule-store.ts'
import { AsyncLocalStorage } from 'node:async_hooks'

import {
  getWorkspace,
  withWorkspace,
  type DurableObjectStorageLike,
} from '@cloudflare/computer'
import {
  WorkerShellBackend,
  type WorkerShellLoader,
} from '@cloudflare/computer/backends/worker-shell'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionListMetadata, QueueAction } from '@deepseek-ai/dsh-api-session-controller/types'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  RpcId,
  type HostFrame,
  type MuxFrame,
  type QueuedInboxItem,
  type ServerRequest,
} from './edge-rpc-types.ts'
import { callEdgeApi, dispatchEdgeApi } from './edge-api-dispatch.ts'
import { createUserMessage, freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import { DurableObject } from 'cloudflare:workers'
import { OWNER_SESSION_EXPIRY_HEADER } from './auth.ts'
import { DirectShellBackend } from './direct-shell.ts'
import {
  resolveEdgeModel,
} from './deepseek.ts'
import {
  resolveEdgeDeploymentConfig,
  resolveEdgeDeploymentProfile,
} from './deployment.ts'
import {
  EdgeHttpError,
  MAX_SESSION_CREATE_BODY_BYTES,
  MAX_TURN_BODY_BYTES,
  corsHeaders,
  discardUnreadRequestBody,
  errorResponse,
  jsonResponse,
  readJsonObject,
  requireBoundedString,
  requireBoundedUtf8String,
} from './http.ts'
import {
  EdgeSessionStore,
  EdgeSessionStoreError,
  type EdgeAgentPromptAdmitter,
  type EdgeMuxBaseline,
  disposeAgentHandle,
} from './session-store.ts'
import {
  EdgeTurnId,
  type CancelEdgeTurnResponse,
  type EdgeSession,
} from './protocol.ts'
import {
  createLiveSessionEventStream,
  edgeEventStreamHeaders,
  encodeSessionEvent,
} from './sse.ts'
import {
  executeWorkspaceCommand,
  requireCommand,
  requireWorkspacePath,
  type EdgeCommandTimeoutPolicy,
} from './workspace.ts'
import {
  MAX_MESSAGE_TEXT_BYTES,
  attachPublishedSession,
  createEdgeApi,
  messageTextByteLength,
} from './edge-api.ts'
import { putSkill, deleteSkill, listSkillNames } from './edge-skill-provider.ts'
import type { EdgeApiSessionSummary, EdgeWorkspaceFiles } from './session-store.ts'
import { WorkspaceOrderInvalidError } from '@deepseek-ai/dsh-workspace'
import { DSH_EDGE_VERSION } from './release.ts'
import {
  EDGE_DO_IMAGE_LIMITS,
  EDGE_R2_IMAGE_LIMITS,
  resolveEdgeAttachmentStorage,
} from './edge-attachment-store.ts'

import { MainSessionQueue, SteeringAdmissions, MAIN_WAKE_MS, MAIN_RUN_TIMEOUT_MS, type MainInput } from './main-session-queue.ts'

const EDGE_WORKSPACE_PATH = '/workspace'
const MAX_SESSION_TITLE_LENGTH = 160
const MAX_SESSION_TITLE_BYTES = 640
const MAX_SESSION_ID_LENGTH = 128
const DEFAULT_SESSION_LIST_LIMIT = 50
const MAX_SESSION_LIST_LIMIT = 100
const DEFAULT_REPLAY_EVENT_LIMIT = 128
const MAX_REPLAY_EVENT_LIMIT = 256
const MAX_REPLAY_RESPONSE_BYTES = 1_048_576
const INITIAL_SESSION_LIST_METADATA: SessionListMetadata = { blank: true, lastPromptAt: null }
const OWNER_SESSION_EXPIRED_CLOSE_CODE = 1008
const OWNER_SESSION_EXPIRED_CLOSE_REASON = 'owner session expired'

/** Project one upstream workspace entity to the wire view. */
function workspaceEntityToView(entity: {
  readonly id: WorkspaceId
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly SessionId[]
  readonly createdAt: string
  readonly updatedAt: string
}): WorkspaceView {
  return {
    workspaceId: entity.id,
    path: entity.path,
    title: entity.title,
    sessionIds: [...entity.sessionIds],
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  }
}

interface DownlinkAttachment {
  channel: 'mux' | 'host' | 'remote.mux'
  expiresAt: number
}

/** Whether the Typert gateway reported that no active service exports the endpoint. */
function isUnservedEndpointError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  if (code === 'gateway/definition-unavailable'
    || code === 'gateway/method-unavailable'
    || code === 'gateway/service-unavailable') return true
  return error instanceof Error && error.message.includes('no active Remote method')
}

/** Project a gateway failure onto the RPC wire without inventing a new code. */
function remoteFailureOf(error: unknown): { code: string; message: string; details: object } {
  const remote = error as { code?: unknown; message?: unknown; details?: unknown }
  if (typeof remote.code === 'string' && typeof remote.message === 'string') {
    return {
      code: remote.code,
      message: remote.message,
      details: typeof remote.details === 'object' && remote.details !== null ? remote.details : {},
    }
  }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  }
}

type RemoteStreamEntry = { abort: AbortController; done: Promise<void> }
const remoteStreams = new WeakMap<WebSocket, Map<string, RemoteStreamEntry>>()

/** Mirror the upstream session-list projection fold at the Edge transport seam. */
function applySessionListMetadata(
  state: SessionListMetadata,
  event: SessionEvent,
): SessionListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/** Bindings shared by the entry Worker and each workspace Durable Object. */
export interface EdgeEnv {
  DSH_EDGE_INSTANCE: DurableObjectNamespace<DshEdgeInstance>
  ASSETS: Fetcher
  LOADER?: WorkerShellLoader
  DSH_EDGE_ATTACHMENTS?: R2Bucket
  DSH_EDGE_ACCESS_KEY?: string
  DEEPSEEK_API_KEY?: string
  DEEPSEEK_BASE_URL?: string
  DEEPSEEK_MAX_OUTPUT_TOKENS?: string
  DEEPSEEK_MODEL?: string
  DEEPSEEK_REASONING_EFFORT?: string
  DEEPSEEK_SEARCH_BASE_URL?: string
  DEEPSEEK_STREAM_IDLE_TIMEOUT_MS?: string
  DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS?: string
  DSH_EDGE_MAX_COMMAND_TIMEOUT_MS?: string
}

class DshEdgeObjectBase extends DurableObject<EdgeEnv> {
  workspaceOptions() {
    const backend = this.env.LOADER === undefined
      ? new DirectShellBackend()
      : new WorkerShellBackend({
        loader: this.env.LOADER,
        workspace: {
          binding: 'DSH_EDGE_INSTANCE',
          id: this.ctx.id.toString(),
        },
        ctx: this.ctx,
      })
    return {
      // Computer's preview storage facade and Workers' generated SQL generic
      // differ only in their type parameter; both expose the same runtime API.
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      backends: [backend],
    }
  }
}

const DshEdgeWorkspace = withWorkspace(
  DshEdgeObjectBase,
  self => self.workspaceOptions(),
)

interface ActiveTurn {
  turnId: EdgeTurnId
  turnStartSeq?: number
  agent?: Agent
  cancelRequested: boolean
  accepting: boolean
  wasAdmitted: boolean
  admit?: EdgeAgentPromptAdmitter
  admissionReady: Promise<void>
  releaseComplete: Promise<void>
  resolveAdmissionReady: () => void
  resolveReleaseComplete: () => void
}

/** One isolated persistent workspace with its conversations and active agent turn. */
export class DshEdgeInstance extends DshEdgeWorkspace {
  private readonly attachmentStorage = resolveEdgeAttachmentStorage(
    this.ctx.storage,
    this.env.DSH_EDGE_ATTACHMENTS,
  )
  private readonly sessions = new EdgeSessionStore(
    this.ctx.storage,
    {
      readDeepSeekApiKey: () => this.env.DEEPSEEK_API_KEY,
      attachmentStorage: this.attachmentStorage,
      ...this.env.DEEPSEEK_SEARCH_BASE_URL === undefined
        ? {}
        : { searchBaseURL: this.env.DEEPSEEK_SEARCH_BASE_URL },
      ...this.env.DSH_EDGE_ATTACHMENTS === undefined
        ? {}
        : { attachmentBucket: this.env.DSH_EDGE_ATTACHMENTS },
      ...this.env.DEEPSEEK_BASE_URL === undefined
        ? {}
        : { baseURL: this.env.DEEPSEEK_BASE_URL },
      ...this.env.DEEPSEEK_MODEL === undefined
        ? {}
        : { model: this.env.DEEPSEEK_MODEL },
      ...this.env.DEEPSEEK_MAX_OUTPUT_TOKENS === undefined
        ? {}
        : { maxTokens: this.env.DEEPSEEK_MAX_OUTPUT_TOKENS },
      ...this.env.DEEPSEEK_REASONING_EFFORT === undefined
        ? {}
        : { reasoningEffort: this.env.DEEPSEEK_REASONING_EFFORT },
      ...this.env.DEEPSEEK_STREAM_IDLE_TIMEOUT_MS === undefined
        ? {}
        : { streamIdleTimeoutMs: this.env.DEEPSEEK_STREAM_IDLE_TIMEOUT_MS },
      ...(this.env as unknown as Record<string, unknown>).IMAGES === undefined
        ? {}
        : { images: (this.env as unknown as Record<string, unknown>).IMAGES },
      withWorkspaceFiles: read => this.withWorkspaceFiles(read),
      onLateSessionEvent: (sessionId, event) => {
        this.publishSessionEvent(sessionId, event)
      },
      onProjectionChanged: (sessionId, key, value, seq) => {
        // sessionListMetadata uses a dedicated push with its own fold logic in publishSessionEvent
        if (key === 'sessionListMetadata') return
        let queue = this.pendingProjections.get(sessionId)
        if (queue === undefined) {
          queue = []
          this.pendingProjections.set(sessionId, queue)
        }
        queue.push({ key, value, seq })
      },
    },
  )
  private readonly model = resolveEdgeModel(this.env.DEEPSEEK_MODEL)
  private scheduleRetryAt = 0
  private readonly mainQueue = new MainSessionQueue(this.ctx.storage)
  private readonly steeringAdmissions = new SteeringAdmissions()
  private mainDriving = false
  private mainStreamCount = 0
  private readonly controlTarget = new AsyncLocalStorage<EdgeTurnId>()
  private readonly runtimeQueueListeners = new Set<(sessionId: SessionId) => void>()
  private readonly liveQueues = new Map<SessionId, QueuedInboxItem[]>()
  private readonly mainStreams = new Map<number, Set<{ publish(event: SessionEvent): void; resolve(): void; reject(error: unknown): void }>>()
  private readonly activeTurns = new Map<SessionId, ActiveTurn>()
  private readonly sessionListMetadata = new Map<SessionId, SessionListMetadata>()
  private readonly pendingProjections = new Map<SessionId, { key: string; value: unknown; seq: number }[]>()
  private readonly api = createEdgeApi({
    sessions: this.sessions,
    model: this.model,
    version: DSH_EDGE_VERSION,
    imageLimits: this.attachmentStorage === 'temporary-do'
      ? EDGE_DO_IMAGE_LIMITS
      : EDGE_R2_IMAGE_LIMITS,
    deploymentProfile: () => resolveEdgeDeploymentProfile(this.env, this.attachmentStorage),
    describeCredential: ref => this.sessions.describeCredential(ref),
    setCredential: (ref, value) => this.sessions.setCredential(ref, value),
    unsetCredential: ref => this.sessions.unsetCredential(ref),
    settingsWritable: () => this.sessions.settingsWritable(),
    settingsHasDocument: () => this.sessions.settingsHasDocument(),
    describeSettings: () => this.sessions.describeSettings(),
    updateSettings: (ns, patch, rev) => this.sessions.updateSettings(ns, patch, rev),
    replaceSettings: (ns, section, rev) => this.sessions.replaceSettings(ns, section, rev),
    mutateSettings: (ns, ops, rev) => this.sessions.mutateSettings(ns, ops, rev),
    listConfigurableProviders: () => this.sessions.listConfigurableProviders(),
    listLlmProviders: () => this.sessions.listLlmProviders(),
    isRunning: sessionId => this.activeTurns.has(sessionId),
    prompt: input => this.startApiPrompt(input),
    hasPrompt: (sessionId, rpcId, digest) => this.mainQueue.hasReceipt(sessionId, `edge:${rpcId}`, digest),
    updateQueue: (sessionId, itemId, action) => this.updateQueue(sessionId, itemId, action),
    cancel: sessionId => this.requestTurnCancellation(sessionId),
    workspaceList: () => this.listWorkspaces(),
    workspaceCreate: path => this.createWorkspace(path),
    workspaceRename: (workspaceId, title) => this.renameWorkspace(workspaceId, title),
    workspaceDelete: workspaceId => this.deleteWorkspace(workspaceId),
    workspaceInsertBefore: (workspaceId, beforeWorkspaceId) =>
      this.reorderWorkspace(workspaceId, beforeWorkspaceId),
    workspaceInsertSessionBefore: (workspaceId, sessionId, beforeSessionId) =>
      this.insertSessionBefore(workspaceId, sessionId, beforeSessionId),
    archiveSession: sessionId => this.archiveSession(sessionId),
    sessionCreated: (session) => {
      this.publishSessionCreated(session)
    },
    sessionAttached: (session, workspaceId) => this.publishSessionAttached(session, workspaceId),
    workspaceForSession: sessionId => this.workspaceForSession(sessionId),
    sessionEvent: (sessionId, event) => {
      this.publishSessionEvent(sessionId, event)
    },
  })
  private readonly apiFetch = (request: Request) => dispatchEdgeApi(this.api, request)

  constructor(ctx: DurableObjectState, env: EdgeEnv) {
    super(ctx, env)
    initializeSchedules(ctx.storage)
    // HTTP/alarm wakes must also reconnect hibernation-restored Remote carriers.
    // Otherwise an open socket can outlive all its process-local stream pumps.
    this.closeExpiredDownlinks()
  }

  /** Serve session routes forwarded by the entry Worker. */
  override async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      const typertResponse = await this.handleTypertRpc(request, url)
      if (typertResponse !== undefined) return typertResponse
      if (url.pathname === '/api/events.mux' || url.pathname === '/api/events.host') {
        return await this.openDownlink(request, url.pathname === '/api/events.mux' ? 'mux' : 'host')
      }
      if (url.pathname === '/api/remote.mux') {
        return this.openRemoteMux(request)
      }
      if (url.pathname === '/api/skills') {
        return await this.handleSkillsCrud(request)
      }
      if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/sessions')) {
        const expected = request.headers.get('x-dsh-edge-turn-seq')
        if (expected !== null && ['/api/session.cancel', '/api/session.prompt', '/api/session.updateQueue'].includes(url.pathname)) {
          const body = await readJsonObject(request.clone() as Request, MAX_TURN_BODY_BYTES)
          const payload = body.payload as { sessionId?: string } | undefined
          return await this.withObservedTurn(expected, payload?.sessionId, () => this.apiFetch(request))
        }
        return await this.apiFetch(request)
      }
      const route = parseSessionRoute(url.pathname)

      if (route.sessionId === undefined) {
        if (request.method === 'POST') return await this.createSession(request)
        if (request.method === 'GET') {
          const after = resolveSessionListAfter(url)
          const limit = resolveSessionListLimit(url)
          const page = await this.sessions.listSessions(after, limit)
          if (page === undefined) throw new EdgeHttpError(400, 'Unknown session list cursor.')
          return jsonResponse({
            sessions: page.sessions.map(session => this.presentSession(session)),
            hasMore: page.hasMore,
            ...page.nextAfter === undefined ? {} : { nextAfter: page.nextAfter },
          })
        }
      } else if (route.action === undefined) {
        if (request.method === 'GET') {
          const session = await this.sessions.getSession(route.sessionId)
          if (session === undefined) throw new EdgeHttpError(404, 'Session not found.')
          return jsonResponse({ session: this.presentSession(session) })
        }
      } else if (route.action === 'events' && request.method === 'GET') {
        return await this.replayEvents(request, url, route.sessionId)
      } else if (route.action === 'turn' && request.method === 'POST') {
        return await this.startTurn(request, route.sessionId)
      } else if (route.action === 'cancel' && request.method === 'POST') {
        return this.cancelTurn(route.sessionId, request)
      }

      throw new EdgeHttpError(404, 'Session route not found.')
    } catch (error) {
      await discardUnreadRequestBody(request)
      return errorResponse(error)
    }
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (this.closeExpiredDownlink(socket, Date.now())) return
    const attachment = readDownlinkAttachment(socket)
    if (attachment?.channel === 'remote.mux') {
      if (typeof message !== 'string') {
        socket.close(1003, 'text messages required')
        return
      }
      this.handleRemoteMuxMessage(socket, message)
      return
    }
    socket.close(1008, 'downlink only')
  }

  override webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    this.abortRemoteStreams(socket)
  }

  override webSocketError(socket: WebSocket, error: unknown): void {
    console.error('dsh-edge downstream WebSocket failed.', error)
    this.abortRemoteStreams(socket)
    socket.close(1011, 'downstream failure')
  }

  /** End hibernating downlinks when the owner session used to open them expires. */
  override async alarm(): Promise<void> {
    await this.driveMain(true)
    await this.scheduleMainWake()
  }

  private async scheduleMainWake(): Promise<void> {
    const expiry = this.closeExpiredDownlinks()
    const work = this.mainQueue.hasWork()
      ? Date.now() + (this.mainDriving || this.mainQueue.current() !== undefined ? MAIN_WAKE_MS : 1)
      : undefined
    const schedule = nextSchedule(this.ctx.storage)
    const due = scheduleWakeTime(schedule?.due, this.scheduleRetryAt, this.mainDriving)
    const times = [expiry, work, due].filter((time): time is number => time !== undefined)
    const next = times.length === 0 ? undefined : Math.min(...times)
    if (next === undefined) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(next)
  }

  private kickMain(): void {
    void this.driveMain(false).catch((error: unknown) => {
      console.error('dsh-edge main session scheduler failed.', error)
    })
  }

  private async driveMain(fromAlarm: boolean): Promise<void> {
    if (this.mainDriving || this.activeTurns.size > 0) return
    this.mainDriving = true
    const stopAt = Date.now() + MAIN_RUN_TIMEOUT_MS
    try {
      const stale = this.mainQueue.current()
      if (stale !== undefined) {
        const input = this.mainQueue.get(stale.seq)
        if (input !== undefined) {
          // The constructor has no old JS owner. Prepare and close its canonical suffix.
          const handle = await this.sessions.openAgentForTurn(SessionId(input.sessionId), this.model)
          handle.agent.inbox.clear()
          await handle.dispose()
          this.mainQueue.finish(stale.seq, stale.epoch, true)
          this.publishAgentError(SessionId(input.sessionId), new Error('Execution interrupted. Send a new message to continue; pending inputs are paused.'))
        }
      }
      do {
        const due = nextSchedule(this.ctx.storage)
        if (due !== undefined && due.due <= Date.now() && this.scheduleRetryAt <= Date.now()) {
          // No progress (including a preparation error) must not create a hot alarm loop.
          this.scheduleRetryAt = Date.now() + MAIN_WAKE_MS
          try {
            if (await this.sessions.dispatchDueSchedules(SessionId(due.sessionId), this.model, this.ctx.storage)) this.scheduleRetryAt = 0
          } catch (error) {
            // A broken reminder must not prevent healthy queued sessions from claiming the slot.
            console.error('dsh-edge reminder preparation failed; retry is deferred.', error)
          }
        }
        const claim = this.mainQueue.claim()
        if (claim === undefined) break
        const { input, epoch } = claim
        const sessionId = SessionId(input.sessionId)
        let failure: unknown
        let interrupted = false
        let turnClaimed = false
        let timer: ReturnType<typeof setTimeout> | undefined
        await this.scheduleMainWake()
        try {
          const { commandTimeoutPolicy } = resolveEdgeDeploymentConfig(this.env)
          const claimed = await this.claimTurn(sessionId)
          turnClaimed = true
          this.publishSessionQueue(sessionId)
          timer = setTimeout(() => {
            interrupted = true
            claimed.turn.cancelRequested = true
            claimed.handle.agent.cancel({ kind: 'user' })
          }, Math.max(1, claim.deadline - Date.now()))
          await this.runClaimedTurn({ claimed, commandTimeoutPolicy, mode: 'queue',
            message: input.message, content: input.message.content,
            publish: event => {
              for (const observer of this.mainStreams.get(input.seq) ?? []) observer.publish(event)
            },
          })
        } catch (error) { failure = error; interrupted = true }
        finally {
          clearTimeout(timer)
          // Settle only after upstream teardown has released the live owner.
          if (!this.activeTurns.has(sessionId)) {
            this.mainQueue.finish(input.seq, epoch, interrupted)
            this.liveQueues.delete(sessionId)
            this.publishSessionQueue(sessionId)
            if (failure !== undefined) {
              console.error('dsh-edge main queue turn failed.', failure)
              if (!turnClaimed) {
                const turnError = failure instanceof Error ? failure : new Error('Main queue turn failed with a non-Error value.')
                this.publishAgentError(sessionId, turnError)
              }
            }
            for (const observer of this.mainStreams.get(input.seq) ?? []) {
              if (failure === undefined) observer.resolve()
              else observer.reject(failure)
            }
            this.mainStreams.delete(input.seq)
          }
        }
        if (this.activeTurns.has(sessionId)) throw failure ?? new Error('Main session cleanup did not finish.')
      } while (!fromAlarm && Date.now() < stopAt)
    } finally {
      this.mainDriving = false
      await this.scheduleMainWake()
    }
  }

  private async enqueueMain(sessionId: SessionId, content: ContentBlock[], rpcId?: RpcId, clientTimeZone?: string, contentDigest?: string, announce = true): Promise<MainInput> {
    resolveEdgeDeploymentConfig(this.env)
    await this.sessions.getApiSessionSummary(sessionId)
    const identity = rpcId ?? RpcId(crypto.randomUUID())
    if (String(identity).length > 128) throw new EdgeHttpError(400, 'Input identity exceeds 128 characters.')
    const inputId = `edge:${identity}`
    const digestBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ content, clientTimeZone })))
    const digest = contentDigest ?? Array.from(new Uint8Array(digestBytes), byte => byte.toString(16).padStart(2, '0')).join('')
    const message = freezeMessage({ ...createUserMessage({ content, source: {
      kind: 'user', ...rpcId === undefined ? {} : { rpcId }, ...clientTimeZone === undefined ? {} : { clientTimeZone },
    } }), id: MessageId(inputId) })
    const input = this.mainQueue.enqueue(sessionId, inputId, digest, message, !announce)
    await this.scheduleMainWake()
    if (announce) this.publishSessionQueue(sessionId)
    return input
  }

  private async openDownlink(request: Request, channel: 'mux' | 'host'): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      throw new EdgeHttpError(426, 'This event endpoint requires a WebSocket upgrade.')
    }
    const expiresAt = requireOwnerSessionExpiry(request)
    await this.scheduleDownlinkExpiry(expiresAt * 1_000)
    const accept = (baseline?: EdgeMuxBaseline) => {
      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      server.serializeAttachment({ channel, expiresAt } satisfies DownlinkAttachment)
      this.ctx.acceptWebSocket(server, [channel])
      if (baseline !== undefined) {
        for (const session of baseline.sessions) {
          this.rememberSessionListMetadata(session)
          if (!this.sendFrame(server, {
            type: 'session/subscribed',
            sessionId: session.id,
            lastSeq: session.lastSeq,
          })) break
        }
        const queues = new Map(baseline.queues.map(queue => [queue.sessionId, queue.items]))
        for (const id of this.mainQueue.sessions()) if (!queues.has(SessionId(id))) queues.set(SessionId(id), [])
        for (const [sessionId, liveItems] of queues) {
          const queue = { sessionId, items: [...liveItems, ...this.mainQueue.pending(sessionId).map(input => ({ id: input.message.id, placement: 'queued' as const, message: input.message }))] }
          if (!this.sendFrame(server, {
            type: 'session/queue',
            sessionId: queue.sessionId,
            items: queue.items,
          })) break
        }
      }
      return new Response(null, { status: 101, webSocket: client })
    }
    return channel === 'mux' ? this.sessions.withMuxBaseline(accept) : accept()
  }

  private async openRemoteMux(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      throw new EdgeHttpError(426, 'This endpoint requires a WebSocket upgrade.')
    }
    const expiresAt = requireOwnerSessionExpiry(request)
    await this.scheduleDownlinkExpiry(expiresAt * 1_000)
    const pair = new WebSocketPair()
    const server = pair[1]
    server.serializeAttachment({ channel: 'remote.mux', expiresAt } satisfies DownlinkAttachment)
    this.ctx.acceptWebSocket(server, ['remote.mux'])
    remoteStreams.set(server, new Map())
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private handleRemoteMuxMessage(socket: WebSocket, text: string): void {
    let message: { type: string; streamId?: string; endpoint?: string; payload?: unknown }
    try {
      message = JSON.parse(text) as typeof message
      if (typeof message?.type !== 'string') throw new Error()
    } catch {
      socket.close(1008, 'invalid Remote stream request')
      return
    }
    const streams = remoteStreams.get(socket)
    if (streams === undefined) {
      // A hibernation-restored socket has no process-local stream state and its
      // previously pumped streams died with the old isolate. Close it so the
      // client's reconnect path re-opens every logical stream cleanly.
      socket.close(1011, 'Remote stream state was lost; reconnect')
      return
    }

    if (message.type === 'cancel' && typeof message.streamId === 'string') {
      streams.get(message.streamId)?.abort.abort(new Error('Remote stream cancelled'))
      return
    }

    if (message.type !== 'open'
      || typeof message.streamId !== 'string'
      || typeof message.endpoint !== 'string') {
      return
    }

    const { streamId, endpoint, payload } = message
    if (streams.has(streamId)) {
      socket.close(1008, 'duplicate Remote stream id')
      return
    }

    const gateway = this.sessions.typertGateway()
    if (gateway === undefined) {
      const error = { code: 'gateway/service-unavailable', message: 'gateway not available', details: {} }
      try { socket.send(JSON.stringify({ type: 'error', streamId, error })) } catch {}
      return
    }

    const abort = new AbortController()
    const done = this.pumpRemoteStream(socket, gateway, streamId, endpoint, payload, abort)
      .catch(() => {})
    streams.set(streamId, { abort, done })
    void done.then(() => { if (streams.get(streamId)?.abort === abort) streams.delete(streamId) })
  }

  private async pumpRemoteStream(
    socket: WebSocket,
    gateway: { wireStream: { open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>; failure(error: unknown): { code: string; message: string; details: object } } },
    streamId: string,
    endpoint: string,
    payload: unknown,
    abort: AbortController,
  ): Promise<void> {
    const control = endpoint === 'session/control'
    const sendQueue = (sessionId: SessionId) => {
      if (socket.readyState === WebSocket.OPEN && !abort.signal.aborted) socket.send(JSON.stringify({
        type: 'item', streamId, value: { type: 'queue', sessionId, items: this.runtimeQueueItems(sessionId) },
      }))
    }
    try {
      const source = await gateway.wireStream.open(endpoint, payload, abort.signal)
      for await (const value of source) {
        if (socket.readyState !== WebSocket.OPEN) break
        let outgoing = value
        if (control) {
          const frame = value as { type: string; sessionId?: string; items?: unknown[]; value?: { queues: Record<string, unknown[]> } }
          if (frame.type === 'baseline' && frame.value !== undefined) {
            const queues = { ...frame.value.queues }
            for (const id of new Set([...Object.keys(queues), ...this.mainQueue.sessions()])) queues[id] = this.runtimeQueueItems(SessionId(id), queues[id])
            outgoing = { ...frame, value: { ...frame.value, queues } }
            this.runtimeQueueListeners.add(sendQueue)
          } else if (frame.type === 'queue' && frame.sessionId !== undefined) {
            outgoing = { ...frame, items: this.runtimeQueueItems(SessionId(frame.sessionId), frame.items) }
          }
        }
        socket.send(JSON.stringify({ type: 'item', streamId, value: outgoing }))
      }
      if (!abort.signal.aborted && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'end', streamId }))
      }
    } catch (error) {
      if (!abort.signal.aborted && socket.readyState === WebSocket.OPEN) {
        try {
          const failure = gateway.wireStream.failure(error)
          socket.send(JSON.stringify({ type: 'error', streamId, error: failure }))
        } catch {
          socket.close(1011, 'Remote stream failure could not be delivered')
        }
      }
    } finally {
      this.runtimeQueueListeners.delete(sendQueue)
    }
  }

  private abortRemoteStreams(socket: WebSocket): void {
    const streams = remoteStreams.get(socket)
    if (streams === undefined) return
    for (const entry of streams.values()) entry.abort.abort(new Error('Remote stream socket closed'))
    remoteStreams.delete(socket)
  }

  private publishSessionCreated(session: EdgeApiSessionSummary): void {
    this.rememberSessionListMetadata(session)
    this.broadcast('mux', {
      type: 'session/subscribed',
      sessionId: session.id,
      lastSeq: session.lastSeq,
    })
    this.broadcast('host', {
      type: 'host/session-added',
      sessionId: session.id,
      blank: session.blank,
      ...session.parentSessionId === undefined
        ? {}
        : { parentSessionId: session.parentSessionId },
      ...session.origin === undefined ? {} : { origin: session.origin },
      ...session.cwd === undefined ? {} : { cwd: session.cwd },
      ...session.agentPreset === undefined ? {} : { agentPreset: session.agentPreset },
    })
  }

  private async publishSessionAttached(
    session: EdgeApiSessionSummary,
    workspaceId: WorkspaceId,
  ): Promise<void> {
    const registry = await this.sessions.workspaceRegistry()
    const entity = registry.get(workspaceId)
    if (entity === undefined) throw new Error(`Workspace "${workspaceId}" not found.`)
    await entity.attachSession(session.id)
    const workspace = workspaceEntityToView(entity)
    this.broadcast('host', { type: 'host/workspace-changed', workspace })
  }

  /** Run one bounded Computer workspace operation outside an agent turn. */
  private async withWorkspaceFiles<T>(read: (files: EdgeWorkspaceFiles) => Promise<T>): Promise<T> {
    using workspace = await getWorkspace(this)
    return await read(workspace.fs as unknown as EdgeWorkspaceFiles)
  }

  private async workspaceForSession(sessionId: SessionId): Promise<WorkspaceId | undefined> {
    const registry = await this.sessions.workspaceRegistry()
    for (const entity of registry.list()) {
      if (entity.sessionIds.includes(sessionId)) return entity.id
    }
    return undefined
  }

  private async listWorkspaces(): Promise<{
    items: WorkspaceView[]
    archivedSessionIds: SessionId[]
  }> {
    const registry = await this.sessions.workspaceRegistry()
    return {
      items: registry.list().map(workspaceEntityToView),
      archivedSessionIds: [...registry.archivedSessionIds],
    }
  }

  private async createWorkspace(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
    const registry = await this.sessions.workspaceRegistry()
    const existing = await registry.resolveByPath(path)
    if (existing !== undefined) {
      return { workspace: workspaceEntityToView(existing), created: false }
    }
    const entity = await registry.create(path)
    const workspace = workspaceEntityToView(entity)
    this.broadcast('host', { type: 'host/workspace-changed', workspace })
    return { workspace, created: true }
  }

  private async renameWorkspace(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    const registry = await this.sessions.workspaceRegistry()
    const entity = registry.get(workspaceId)
    if (entity === undefined) throw new WorkspaceOrderInvalidError(workspaceId)
    const previousTitle = entity.title
    await entity.setTitle(title)
    const workspace = workspaceEntityToView(entity)
    if (previousTitle !== title) {
      this.broadcast('host', { type: 'host/workspace-changed', workspace })
    }
    return workspace
  }

  private async deleteWorkspace(workspaceId: WorkspaceId): Promise<void> {
    const registry = await this.sessions.workspaceRegistry()
    const deleted = await registry.delete(workspaceId)
    if (!deleted) {
      throw new WorkspaceOrderInvalidError(workspaceId)
    }
    this.broadcast('host', { type: 'host/workspace-removed', workspaceId })
  }

  private async reorderWorkspace(
    workspaceId: WorkspaceId,
    beforeWorkspaceId?: WorkspaceId,
  ): Promise<WorkspaceId[]> {
    const registry = await this.sessions.workspaceRegistry()
    return [...await registry.insertBefore(workspaceId, beforeWorkspaceId)]
  }

  private async insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView> {
    const registry = await this.sessions.workspaceRegistry()
    const entity = registry.get(workspaceId)
    if (entity === undefined) throw new WorkspaceOrderInvalidError(workspaceId)
    await entity.insertSessionBefore(sessionId, beforeSessionId)
    const workspace = workspaceEntityToView(entity)
    this.broadcast('host', { type: 'host/workspace-changed', workspace })
    return workspace
  }

  /** Archive with the same registry-global snapshot and frame contract as upstream. */
  private async archiveSession(sessionId: SessionId): Promise<SessionId[]> {
    const registry = await this.sessions.workspaceRegistry()
    const previousCount = registry.archivedSessionIds.length
    await registry.archiveSession(sessionId)
    const archivedSessionIds = [...registry.archivedSessionIds]
    if (archivedSessionIds.length !== previousCount) {
      this.broadcast('host', {
        type: 'host/archived-sessions-changed',
        archivedSessionIds,
      })
    }
    return archivedSessionIds
  }

  private async handleTypertRpc(request: Request, url: URL): Promise<Response | undefined> {
    const match = /^\/api\/([a-zA-Z0-9_$.-]+)\/([a-zA-Z0-9_$.-]+)$/.exec(url.pathname)
    if (match === null || request.method !== 'POST') return undefined
    let body: Record<string, unknown>
    try { body = await request.json() as Record<string, unknown> } catch { return new Response('invalid JSON', { status: 400 }) }
    const rpcId = body.rpcId as string | undefined ?? 'unknown'
    const payload = body.payload as Record<string, unknown> | undefined
    const args = payload?.args as Record<string, unknown> | undefined ?? {}
    const ns = match[1]!
    const method = match[2]!
    const edgeDispatch = async () => {
      const keys = Object.keys(args)
      const flatArgs = keys.length === 1 && keys[0] === 'request'
        ? args.request as Record<string, unknown>
        : args
      try {
        const called = await callEdgeApi(
          this.api,
          `${ns}.${method}`,
          RpcId(rpcId),
          flatArgs,
          request.signal,
        )
        if (called === undefined) return new Response('not found', { status: 404 })
        return Response.json({ type: 'server-response', rpcId: called.rpcId, result: called.result })
      } catch (error) {
        // Same error envelope the HTTP dispatcher produces, so handler
        // rejections stay correlated server-responses on the direct path.
        return Response.json({ type: 'server-response', rpcId, result: {
          ok: false,
          error: { code: 'internal', message: String(error), details: {} },
        } })
      }
    }
    // The browser settles a forwarded Agent-scoped waterfall (user questions)
    // through the gateway-owned `$events/result` endpoint. It is not a Remote
    // method, so it dispatches through the interceptor the gateway registered
    // on the Edge connection seam rather than `invoke()`.
    if (ns === '$events') {
      const endpoint = `${ns}/${method}`
      const interceptor = this.sessions.typertRpcInterceptor()
      if (interceptor === undefined || !interceptor.claims(endpoint)) {
        return new Response('not found', { status: 404 })
      }
      const result = await interceptor.dispatch(endpoint, payload, request.signal)
      return Response.json({ type: 'server-response', rpcId, result })
    }
    // The Edge owns the turn lifecycle: agents open per turn and dispose when
    // it ends, matching Durable Object eviction, while the upstream controller
    // assumes resident agents it can resume and keep. Prompt admission and
    // cancellation stay on the Edge implementation until that lifecycle
    // reconciliation lands.
    if (ns === 'session' && ['list', 'create', 'prompt', 'cancel', 'updateQueue', 'selectModel', 'rename', 'fork'].includes(method)) {
      const expected = request.headers.get('x-dsh-edge-turn-seq')
      if (expected !== null && ['prompt', 'cancel', 'updateQueue'].includes(method)) {
        const flatArgs = Object.keys(args).length === 1 && 'request' in args
          ? args.request as { sessionId?: string } : args as { sessionId?: string }
        return this.withObservedTurn(expected, flatArgs?.sessionId, edgeDispatch)
      }
      return edgeDispatch()
    }
    const gateway = this.sessions.typertGateway()
    if (gateway === undefined) return edgeDispatch()
    try {
      const invoke = () => gateway.invoke({ namespace: ns, method, args, signal: AbortSignal.timeout(30_000) })
      // Agent-scoped commands (including /plan) use the same residency budget.
      // Their upstream lookup may otherwise leave a cold Agent permanently live.
      const value = typeof args.agentId === 'string'
        ? await this.withAgentControl(SessionId(args.agentId), invoke)
        : await invoke()
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } })
    } catch (error) {
      // Only endpoints no registered controller serves fall back to the Edge
      // API; validation and business failures surface as the gateway reported
      // them so protocol regressions stay visible.
      if (isUnservedEndpointError(error)) {
        try { return await edgeDispatch() } catch {}
      }
      return Response.json({ type: 'server-response', rpcId, result: {
        ok: false,
        error: remoteFailureOf(error),
      } })
    }
  }

  /** Both HTTP spellings bind controls to the same observed run before dispatch. */
  private withObservedTurn<T>(expected: string, sessionId: string | undefined, dispatch: () => Promise<T>): Promise<T> {
    const active = sessionId === undefined ? undefined : this.activeTurns.get(SessionId(sessionId))
    if (active === undefined || active.turnStartSeq === undefined || String(active.turnStartSeq) !== expected) throw new EdgeHttpError(409, 'The observed run has ended.')
    return this.controlTarget.run(active.turnId, dispatch)
  }

  private async withAgentControl<T>(sessionId: SessionId, invoke: () => Promise<T>): Promise<T> {
    if (this.activeTurns.get(sessionId)?.agent !== undefined) return invoke()
    if (this.mainDriving || this.activeTurns.size > 0) throw new EdgeSessionStoreError('BUSY', 'The main slot is occupied; retry this command after the current turn.')
    this.mainDriving = true
    try {
      const model = resolveEdgeDeploymentConfig(this.env).model
      const handle = await this.sessions.openAgentForTurn(sessionId, model)
      try { return await invoke() }
      finally { await handle.dispose() }
    } finally {
      this.mainDriving = false
      this.kickMain()
    }
  }

  private publishSessionEvent(sessionId: SessionId, event: SessionEvent): void {
    this.broadcast('mux', { type: 'session/event', sessionId, event })
    const previous = this.sessionListMetadata.get(sessionId) ?? INITIAL_SESSION_LIST_METADATA
    const next = applySessionListMetadata(previous, event)
    if (next !== previous) {
      this.sessionListMetadata.set(sessionId, next)
      this.broadcast('mux', {
        type: 'session/projection',
        sessionId,
        key: 'sessionListMetadata',
        value: next,
        seq: event.seq,
      })
    }
    const pending = this.pendingProjections.get(sessionId)
    if (pending !== undefined && pending.length > 0) {
      const ready = pending.filter(e => e.seq <= event.seq)
      const remaining = pending.filter(e => e.seq > event.seq)
      this.pendingProjections.set(sessionId, remaining)
      for (const entry of ready) {
        this.broadcast('mux', {
          type: 'session/projection',
          sessionId,
          key: entry.key,
          value: entry.value,
          seq: entry.seq,
        })
      }
    }
  }

  private rememberSessionListMetadata(session: EdgeApiSessionSummary): void {
    this.sessionListMetadata.set(session.id, {
      blank: session.blank,
      lastPromptAt: session.lastPromptAt,
    })
  }

  private runtimeQueueItems(sessionId: SessionId, live?: readonly unknown[]): unknown[] {
    return [...(live ?? this.liveQueues.get(sessionId) ?? []), ...this.mainQueue.pending(sessionId).map(input => ({ id: input.message.id, placement: 'queued', message: input.message }))]
  }

  private publishSessionQueue(sessionId: SessionId, items?: QueuedInboxItem[]): void {
    if (items !== undefined) this.liveQueues.set(sessionId, items)
    for (const listener of this.runtimeQueueListeners) listener(sessionId)
    this.broadcast('mux', { type: 'session/queue', sessionId, items: [...(this.liveQueues.get(sessionId) ?? []), ...this.mainQueue.pending(sessionId).map(input => ({ id: input.message.id, placement: 'queued' as const, message: input.message }))] })
  }

  private publishRunning(sessionId: SessionId, running: boolean): void {
    this.broadcast('host', { type: 'host/session-status', sessionId, running })
  }

  private publishAgentError(sessionId: SessionId, error: unknown): void {
    this.broadcast('host', {
      type: 'host/agent-error',
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  private broadcast(channel: 'mux', frame: MuxFrame): void
  private broadcast(channel: 'host', frame: HostFrame): void
  private broadcast(channel: 'mux' | 'host', frame: MuxFrame | HostFrame): void {
    const now = Date.now()
    for (const socket of this.ctx.getWebSockets(channel)) {
      if (socket.readyState !== WebSocket.OPEN) continue
      if (this.closeExpiredDownlink(socket, now)) continue
      try {
        this.sendFrame(socket, frame)
      } catch (error) {
        console.error(`dsh-edge failed to publish ${frame.type}.`, error)
        socket.close(1011, 'downstream send failed')
      }
    }
  }

  private sendFrame(socket: WebSocket, frame: MuxFrame | HostFrame): boolean {
    if (this.closeExpiredDownlink(socket, Date.now())) return false
    const message: ServerRequest = {
      type: 'server-request',
      rpcId: RpcId(crypto.randomUUID()),
      method: frame.type,
      payload: frame,
    }
    socket.send(JSON.stringify(message))
    return true
  }

  private closeExpiredDownlinks(now = Date.now()): number | undefined {
    let nextExpiry: number | undefined
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readDownlinkAttachment(socket)
      if (attachment === undefined || attachment.expiresAt * 1_000 <= now) {
        socket.close(OWNER_SESSION_EXPIRED_CLOSE_CODE, OWNER_SESSION_EXPIRED_CLOSE_REASON)
        continue
      }
      if (attachment.channel === 'remote.mux' && !remoteStreams.has(socket)) {
        socket.close(1011, 'Remote stream state was lost; reconnect')
        continue
      }
      const expiresAt = attachment.expiresAt * 1_000
      nextExpiry = nextExpiry === undefined ? expiresAt : Math.min(nextExpiry, expiresAt)
    }
    return nextExpiry
  }

  private closeExpiredDownlink(socket: WebSocket, now: number): boolean {
    const attachment = readDownlinkAttachment(socket)
    if (attachment !== undefined && attachment.expiresAt * 1_000 > now) return false
    socket.close(OWNER_SESSION_EXPIRED_CLOSE_CODE, OWNER_SESSION_EXPIRED_CLOSE_REASON)
    return true
  }

  private async scheduleDownlinkExpiry(expiresAt: number): Promise<void> {
    const scheduled = await this.ctx.storage.getAlarm()
    if (scheduled === null || expiresAt < scheduled) {
      await this.ctx.storage.setAlarm(expiresAt)
    }
  }

  private async handleSkillsCrud(request: Request): Promise<Response> {
    const storage = this.ctx.storage
    if (request.method === 'GET') {
      const names = await listSkillNames(storage)
      return jsonResponse({ skills: names })
    }
    if (request.method === 'PUT') {
      const body = await readJsonObject(request, 262_144)
      const name = requireBoundedString(body.name, 'name', 128)
      const description = requireBoundedString(body.description, 'description', 512)
      const content = requireBoundedUtf8String(body.content, 'content', 65_536)
      await putSkill(storage, {
        name,
        description,
        content,
        ...typeof body.whenToUse === 'string' ? { whenToUse: requireBoundedString(body.whenToUse, 'whenToUse', 1024) } : {},
        ...typeof body.modelInvocable === 'boolean' ? { modelInvocable: body.modelInvocable } : {},
        ...typeof body.userInvocable === 'boolean' ? { userInvocable: body.userInvocable } : {},
      })
      return jsonResponse({ ok: true, name })
    }
    if (request.method === 'DELETE') {
      const body = await readJsonObject(request, 1024)
      const name = requireBoundedString(body.name, 'name', 128)
      const deleted = await deleteSkill(storage, name)
      return jsonResponse({ ok: true, name, deleted })
    }
    throw new EdgeHttpError(405, 'Method not allowed.')
  }

  private async createSession(request: Request): Promise<Response> {
    const body = await readJsonObject(request, MAX_SESSION_CREATE_BODY_BYTES)
    const title = normalizeSessionTitle(
      requireBoundedString(body.title, 'title', MAX_SESSION_TITLE_LENGTH),
      MAX_SESSION_TITLE_BYTES,
    )
    if (title.length === 0) {
      throw new EdgeHttpError(400, 'Session title must contain visible text.')
    }
    const session = await this.sessions.createSession({ title })
    const presented = this.presentSession(session)
    const summary = (await this.sessions.listApiSessions())
      .find(item => item.id === session.id)
    if (summary !== undefined) this.publishSessionCreated(summary)
    const registry = await this.sessions.workspaceRegistry()
    const edgeWorkspace = await registry.resolveByPath(EDGE_WORKSPACE_PATH)
    const edgeWorkspaceId = edgeWorkspace?.id
    const attachmentError = edgeWorkspaceId === undefined
      ? undefined
      : await attachPublishedSession(
        session.id,
        edgeWorkspaceId,
        'created',
        async () => {
          if (summary !== undefined) {
            await this.publishSessionAttached(summary, edgeWorkspaceId)
          }
        },
      )
    if (attachmentError !== undefined) {
      return jsonResponse({
        ok: false,
        error: attachmentError.message,
        code: attachmentError.code,
        details: attachmentError.details,
        session: presented,
      }, 500)
    }
    return jsonResponse({ session: presented }, 201)
  }

  private async replayEvents(request: Request, url: URL, sessionId: SessionId): Promise<Response> {
    const after = resolveAfterSequence(request, url)
    const limit = resolveReplayLimit(url)
    const page = await this.sessions.readEventPage(
      sessionId,
      after + 1,
      limit,
      MAX_REPLAY_RESPONSE_BYTES,
    )
    const chunks: Uint8Array[] = []
    let byteLength = 0
    let hasMore = page.hasMore
    if (page.events.length === 0 && page.hasMore) {
      throw new EdgeHttpError(413, 'The next session event exceeds the replay response limit.')
    }
    for (const event of page.events) {
      const chunk = encodeSessionEvent(event)
      if (byteLength + chunk.byteLength > MAX_REPLAY_RESPONSE_BYTES) {
        if (chunks.length === 0) {
          throw new EdgeHttpError(413, 'The next session event exceeds the replay response limit.')
        }
        hasMore = true
        break
      }
      chunks.push(chunk)
      byteLength += chunk.byteLength
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    const nextAfter = page.events[chunks.length - 1]?.seq ?? after
    const headers = edgeEventStreamHeaders(corsHeaders())
    headers.set('x-dsh-edge-has-more', String(hasMore))
    headers.set('x-dsh-edge-next-after', String(nextAfter))
    return new Response(stream, {
      headers,
    })
  }

  private async startTurn(request: Request, sessionId: SessionId): Promise<Response> {
    const body = await readJsonObject(request, MAX_TURN_BODY_BYTES)
    const message = requireBoundedUtf8String(body.message, 'message', MAX_MESSAGE_TEXT_BYTES)
    const id = request.headers.get('Idempotency-Key')
    if (id !== null && (id.length === 0 || id.length > 128)) throw new EdgeHttpError(400, 'Invalid Idempotency-Key.')
    if (this.mainStreamCount >= 32) throw new EdgeHttpError(429, 'Too many live turn streams.')
    this.mainStreamCount++
    let input: MainInput
    try { input = await this.enqueueMain(sessionId, [{ type: 'text', text: message }], id === null ? undefined : RpcId(id)) }
    catch (error) { this.mainStreamCount--; throw error }
    const { stream, completion } = createLiveSessionEventStream(async (publish, signal) => {
      try {
        await new Promise<void>((resolve, reject) => {
          const state = this.mainQueue.state(input.seq)
          if (signal.aborted || state === 'settled' || state === 'cancelled' || state === 'interrupted') { resolve(); return }
          let observers = this.mainStreams.get(input.seq)
          if (observers === undefined) { observers = new Set(); this.mainStreams.set(input.seq, observers) }
          const cleanup = () => {
            signal.removeEventListener('abort', abort)
            observers.delete(observer)
            if (observers.size === 0) this.mainStreams.delete(input.seq)
          }
          const observer = { publish, resolve: () => { cleanup(); resolve() }, reject: (error: unknown) => { cleanup(); reject(error) } }
          const abort = () => observer.resolve()
          observers.add(observer)
          signal.addEventListener('abort', abort, { once: true })
          this.kickMain()
        })
      } finally { this.mainStreamCount-- }
    }, error => { console.error('dsh-edge turn transport failed.', error) }, 'durably received')
    void completion.catch(() => undefined)
    const headers = edgeEventStreamHeaders(corsHeaders())
    headers.set('x-dsh-edge-input-id', input.inputId)
    return new Response(stream, { status: 200, headers })
  }

  private async startApiPrompt(input: {
    sessionId: SessionId
    mode: 'queue' | 'steer'
    content: ContentBlock[]
    rpcId: RpcId
    clientTimeZone?: string
    contentDigest?: string
  }): Promise<void> {
    if (messageTextByteLength(input.content.filter((part): part is Extract<ContentBlock, { type: 'text' }> => part.type === 'text')) > MAX_MESSAGE_TEXT_BYTES) {
      throw new EdgeHttpError(413, 'Prompt exceeds the message limit.')
    }
    if (input.mode === 'steer') {
      const key = JSON.stringify([input.sessionId, input.rpcId])
      const digest = input.contentDigest ?? JSON.stringify([input.content, input.clientTimeZone])
      return this.steeringAdmissions.run(key, digest, async () => {
        // The earlier API receipt check may have raced a completed admission.
        if (input.contentDigest !== undefined && this.mainQueue.hasReceipt(input.sessionId, `edge:${input.rpcId}`, input.contentDigest)) return
        const active = this.activeTurns.get(input.sessionId)
        if (active === undefined || (this.controlTarget.getStore() !== undefined && this.controlTarget.getStore() !== active.turnId)) throw new EdgeSessionStoreError('BUSY', 'The target run has ended; submit a queued message.')
        await active.admissionReady
        if (this.activeTurns.get(input.sessionId) !== active || !active.accepting || active.admit === undefined) throw new EdgeSessionStoreError('BUSY', 'The target run has ended.')
        const queued = await this.enqueueMain(input.sessionId, input.content, input.rpcId, input.clientTimeZone, input.contentDigest, false)
        // Only the transaction that created this receipt may mutate the inbox.
        if (!queued.created || this.mainQueue.state(queued.seq) !== 'steering') return
        if (this.activeTurns.get(input.sessionId) !== active || !active.accepting) {
          this.mainQueue.finishSteer(input.sessionId, queued.inputId, false)
          throw new EdgeSessionStoreError('BUSY', 'The target run has ended.')
        }
        const admit = active.admit
        await this.mainQueue.admitSteer(input.sessionId, queued.inputId, () => admit({ ...input, message: queued.message }))
      })
    }
    await this.enqueueMain(input.sessionId, input.content, input.rpcId, input.clientTimeZone, input.contentDigest)
    this.kickMain()
  }

  private async updateQueue(
    sessionId: SessionId,
    itemId: MessageId,
    action: QueueAction,
  ): Promise<'accepted' | 'queue-item-not-found' | 'steer-unavailable' | 'queue-edit-attachment-invalid'> {
    const pending = this.mainQueue.pending(sessionId).find(input => input.message.id === itemId)
    if (pending !== undefined) {
      if (action.kind === 'steer') {
        const active = this.activeTurns.get(sessionId)
        if (active?.agent?.status !== 'running' || (this.controlTarget.getStore() !== undefined && this.controlTarget.getStore() !== active.turnId) || !active.accepting || active.admit === undefined) return 'steer-unavailable'
        this.mainQueue.stageSteer(pending.seq)
        const admit = active.admit
        await this.mainQueue.admitSteer(sessionId, pending.inputId, () => admit({ mode: 'steer', content: pending.message.content, message: pending.message }))
        return 'accepted'
      }
      if (action.kind === 'edit') {
        if (!preservesAdmittedQueueImages(pending.message.content, action.content)) return 'queue-edit-attachment-invalid'
        this.mainQueue.edit(sessionId, itemId, { ...pending.message, content: [...action.content] })
      } else {
        this.mainQueue.remove(sessionId, itemId)
        for (const observer of this.mainStreams.get(pending.seq) ?? []) observer.resolve()
        this.mainStreams.delete(pending.seq)
      }
      this.publishSessionQueue(sessionId)
      this.kickMain()
      return 'accepted'
    }
    const active = this.activeTurns.get(sessionId)
    const agent = active?.agent
    if (agent === undefined) return 'queue-item-not-found'
    const target = agent.inbox.nextTurn.some(message => message.id === itemId)
      ? 'next-turn'
      : agent.inbox.nextStep.some(message => message.id === itemId) ? 'next-step' : undefined
    const message = target === undefined
      ? undefined
      : (target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep)
        .find(candidate => candidate.id === itemId)
    if (target === undefined || message === undefined) return 'queue-item-not-found'
    if (action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
      return 'steer-unavailable'
    }
    if (action.kind === 'edit') {
      if (!preservesAdmittedQueueImages(message.content, action.content)) {
        return 'queue-edit-attachment-invalid'
      }
      agent.inbox.replace(itemId, freezeMessage({ ...message, content: [...action.content] } as UserMessage))
    } else {
      agent.inbox.remove(itemId)
      if (action.kind === 'steer') agent.steer(message)
    }
    return 'accepted'
  }

  private async claimTurn(sessionId: SessionId): Promise<{
    sessionId: SessionId
    turn: ActiveTurn
    handle: AgentHandle
  }> {
    const summary = await this.sessions.getApiSessionSummary(sessionId)
    if (this.activeTurns.size > 0) {
      throw new EdgeSessionStoreError('BUSY', 'The session already has a running turn.')
    }
    this.rememberSessionListMetadata(summary)
    const turn: ActiveTurn = {
      turnId: EdgeTurnId(crypto.randomUUID()),
      cancelRequested: false,
      accepting: false,
      wasAdmitted: false,
      ...activeTurnSignals(),
    }
    // Claim before opening the Agent so interleaved DO requests cannot own the same session.
    this.activeTurns.set(sessionId, turn)
    try {
      const handle = await this.sessions.openAgentForTurn(sessionId, this.model)
      turn.agent = handle.agent
      return { sessionId, turn, handle }
    } catch (error) {
      this.activeTurns.delete(sessionId)
      turn.resolveAdmissionReady()
      turn.resolveReleaseComplete()
      throw error
    }
  }

  private async runClaimedTurn(input: {
    message?: UserMessage
    claimed: { sessionId: SessionId; turn: ActiveTurn; handle: AgentHandle }
    commandTimeoutPolicy: EdgeCommandTimeoutPolicy
    content: ContentBlock[]
    mode: 'queue' | 'steer'
    rpcId?: RpcId
    clientTimeZone?: string
    publish?: (event: SessionEvent) => void | Promise<void>
  }): Promise<void> {
    const { sessionId, turn, handle } = input.claimed
    try {
      await this.runTurn({
        ...input,
        agent: handle.agent,
        turn,
        onAdmitted: (admit) => {
          turn.admit = admit
          turn.accepting = true
          turn.wasAdmitted = true
          this.publishRunning(sessionId, true)
          turn.resolveAdmissionReady()
        },
        onClosing: () => {
          turn.accepting = false
        },
        publish: async (event) => {
          if (event.type === 'turn/start') turn.turnStartSeq = event.seq
          this.publishSessionEvent(sessionId, event)
          await input.publish?.(event)
        },
        publishQueue: (items) => {
          this.publishSessionQueue(sessionId, items)
        },
      })
    } catch (error) {
      this.publishAgentError(sessionId, error)
      throw error
    } finally {
      turn.accepting = false
      turn.resolveAdmissionReady()
      await disposeAgentHandle(handle, () => {
        const active = this.activeTurns.get(sessionId)
        if (active?.turnId === turn.turnId) this.activeTurns.delete(sessionId)
        turn.resolveReleaseComplete()
        this.publishRunning(sessionId, false)
      })
    }
  }

  private async runTurn(input: {
    message?: UserMessage
    agent: Agent
    commandTimeoutPolicy: EdgeCommandTimeoutPolicy
    content: ContentBlock[]
    mode: 'queue' | 'steer'
    turn: ActiveTurn
    rpcId?: RpcId
    clientTimeZone?: string
    publish: (event: SessionEvent) => void | Promise<void>
    publishQueue: (items: QueuedInboxItem[]) => void | Promise<void>
    onAdmitted?: (admit: EdgeAgentPromptAdmitter) => void
    onClosing?: () => void
  }): Promise<void> {
    using workspace = await getWorkspace(this)
    const spill = this.sessions.spillStore()
    spill?.bind(workspace.fs)
    const edgeFs = this.sessions.filesystem()
    const runTurn = async () => {
    await this.sessions.runAgentTurn({
      ...input.message === undefined ? {} : { message: input.message },
      agent: input.agent,
      mode: input.mode,
      content: input.content,
      ...input.rpcId === undefined ? {} : { rpcId: input.rpcId },
      ...input.clientTimeZone === undefined
        ? {}
        : { clientTimeZone: input.clientTimeZone },
      shell: {
        exec: async (command, options) => executeWorkspaceCommand(
          workspace,
          requireCommand(command),
          requireWorkspacePath(options.cwd),
          input.commandTimeoutPolicy,
          options.timeoutMs,
          options.signal,
        ),
      },
      afterFollowup: () => {
        if (input.turn.cancelRequested) input.agent.cancel({ kind: 'user' })
      },
      ...input.onAdmitted === undefined ? {} : { onAdmitted: input.onAdmitted },
      ...input.onClosing === undefined ? {} : { onClosing: input.onClosing },
      publish: input.publish,
      publishQueue: input.publishQueue,
    })
    }
    try {
      if (edgeFs !== undefined) {
        await edgeFs.runInScope(
          workspace.fs as never,
          input.agent.session.header.cwd ?? '/workspace',
          runTurn,
        )
      } else {
        await runTurn()
      }
    } finally {
      spill?.unbind()
    }
  }

  private cancelTurn(sessionId: SessionId, request: Request): Response {
    const active = this.activeTurns.get(sessionId)
    const expected = request.headers.get('x-dsh-edge-turn-seq')
    if (expected !== null && String(active?.turnStartSeq) !== expected) throw new EdgeHttpError(409, 'The observed run has ended.')
    if (active === undefined || !this.requestTurnCancellation(sessionId)) {
      throw new EdgeHttpError(409, 'The session has no active turn in this Worker instance.')
    }
    const response: CancelEdgeTurnResponse = {
      ok: true,
      sessionId,
      turnId: active.turnId,
    }
    return jsonResponse(response, 202)
  }

  private requestTurnCancellation(sessionId: SessionId): boolean {
    const active = this.activeTurns.get(sessionId)
    if (active === undefined || (this.controlTarget.getStore() !== undefined && this.controlTarget.getStore() !== active.turnId)) return false
    active.cancelRequested = true
    active.agent?.cancel({ kind: 'user' })
    return true
  }

  private presentSession(session: EdgeSession) {
    return {
      ...session,
      status: this.activeTurns.has(session.id) ? 'running' as const : 'idle' as const,
    }
  }
}

/** Keep queue edits inside the exact attachment authority of one pending message. */
function preservesAdmittedQueueImages(
  original: readonly ContentBlock[],
  edited: readonly ContentBlock[],
): boolean {
  const available = original.flatMap(block => block.type === 'image' ? [block.attachment] : [])
  for (const block of edited) {
    if (block.type === 'text') continue
    if (block.type !== 'image') return false
    const index = available.findIndex(candidate => sameImageRef(candidate, block.attachment))
    if (index < 0) return false
    available.splice(index, 1)
  }
  return true
}

function sameImageRef(left: ImageAttachmentRef, right: ImageAttachmentRef): boolean {
  return left.attachmentId === right.attachmentId
    && left.mediaType === right.mediaType
    && left.bytes === right.bytes
    && left.width === right.width
    && left.height === right.height
    && left.name === right.name
}

function requireOwnerSessionExpiry(request: Request): number {
  const source = request.headers.get(OWNER_SESSION_EXPIRY_HEADER)
  if (source === null || !/^\d{10}$/u.test(source)) {
    throw new EdgeHttpError(401, 'Owner authentication required.')
  }
  const expiresAt = Number(source)
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1_000 <= Date.now()) {
    throw new EdgeHttpError(401, 'Owner authentication required.')
  }
  return expiresAt
}

function readDownlinkAttachment(socket: WebSocket): DownlinkAttachment | undefined {
  try {
    const attachment: unknown = socket.deserializeAttachment()
    if (typeof attachment !== 'object' || attachment === null) return undefined
    const { channel, expiresAt } = attachment as Record<string, unknown>
    if ((channel !== 'mux' && channel !== 'host' && channel !== 'remote.mux')
      || typeof expiresAt !== 'number'
      || !Number.isSafeInteger(expiresAt)) {
      return undefined
    }
    return { channel, expiresAt }
  } catch {
    return undefined
  }
}

function activeTurnSignals(): Pick<ActiveTurn,
  'admissionReady' | 'releaseComplete' | 'resolveAdmissionReady' | 'resolveReleaseComplete'> {
  const admission = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  return {
    admissionReady: admission.promise,
    releaseComplete: release.promise,
    resolveAdmissionReady: admission.resolve,
    resolveReleaseComplete: release.resolve,
  }
}

interface ParsedSessionRoute {
  sessionId?: SessionId
  action?: 'events' | 'turn' | 'cancel'
}

function parseSessionRoute(pathname: string): ParsedSessionRoute {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] !== 'api' || parts[1] !== 'sessions' || parts.length > 4) {
    throw new EdgeHttpError(404, 'Session route not found.')
  }
  if (parts.length === 2) return {}
  let sessionId: string
  try {
    sessionId = decodeURIComponent(parts[2] ?? '')
  } catch {
    throw new EdgeHttpError(400, 'Invalid session id.')
  }
  if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw new EdgeHttpError(400, 'Invalid session id.')
  }
  const id = SessionId(sessionId)
  if (parts.length === 3) return { sessionId: id }
  const action = parts[3]
  if (action !== 'events' && action !== 'turn' && action !== 'cancel') {
    throw new EdgeHttpError(404, 'Session route not found.')
  }
  return { sessionId: id, action }
}

function resolveAfterSequence(request: Request, url: URL): number {
  const value = url.searchParams.get('after') ?? request.headers.get('last-event-id') ?? '-1'
  if (!/^-?\d+$/.test(value)) throw new EdgeHttpError(400, 'after must be an integer.')
  const sequence = Number(value)
  if (!Number.isSafeInteger(sequence) || sequence < -1 || sequence >= Number.MAX_SAFE_INTEGER) {
    throw new EdgeHttpError(400, 'after exceeds the supported integer range.')
  }
  return sequence
}

function resolveSessionListAfter(url: URL): SessionId | undefined {
  const raw = url.searchParams.get('after')
  if (raw === null) return undefined
  if (raw.length === 0 || raw.length > MAX_SESSION_ID_LENGTH) {
    throw new EdgeHttpError(400, 'Invalid session list cursor.')
  }
  return SessionId(raw)
}

function resolveSessionListLimit(url: URL): number {
  const raw = url.searchParams.get('limit')
  if (raw === null) return DEFAULT_SESSION_LIST_LIMIT
  if (!/^\d+$/.test(raw)) throw new EdgeHttpError(400, 'limit must be a positive integer.')
  const limit = Number(raw)
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_SESSION_LIST_LIMIT) {
    throw new EdgeHttpError(400, `limit must be between 1 and ${MAX_SESSION_LIST_LIMIT}.`)
  }
  return limit
}

function resolveReplayLimit(url: URL): number {
  const raw = url.searchParams.get('limit')
  if (raw === null) return DEFAULT_REPLAY_EVENT_LIMIT
  if (!/^\d+$/.test(raw)) throw new EdgeHttpError(400, 'limit must be a positive integer.')
  const limit = Number(raw)
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_REPLAY_EVENT_LIMIT) {
    throw new EdgeHttpError(
      400,
      `limit must be between 1 and ${MAX_REPLAY_EVENT_LIMIT}.`,
    )
  }
  return limit
}
