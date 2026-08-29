/** Workspace Durable Object with persistent sessions and streamed agent turns. */

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
import type {
  HostFrame,
  MuxFrame,
  QueueAction,
  QueuedInboxItem,
  ServerRequest,
  SessionListMetadata,
  WorkspaceId,
  WorkspaceView,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { freezeMessage, type MessageId } from '@deepseek-ai/dsh-llm'
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
import { handleEdgeRemote } from './edge-remotes.ts'
import type { EdgeApiSessionSummary } from './session-store.ts'
import { WorkspaceOrderInvalidError } from '@deepseek-ai/dsh-workspace'
import { DSH_EDGE_VERSION } from './release.ts'
import {
  EDGE_DO_IMAGE_LIMITS,
  EDGE_R2_IMAGE_LIMITS,
  resolveEdgeAttachmentStorage,
} from './edge-attachment-store.ts'

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
  channel: 'mux' | 'host'
  expiresAt: number
}

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
      onLateSessionEvent: (sessionId, event) => {
        this.publishSessionEvent(sessionId, event)
      },
      onProjectionChanged: (sessionId, key, value, seq) => {
        this.broadcast('mux', { type: 'session/projection', sessionId, key, value, seq })
      },
      waitUntil: promise => this.ctx.waitUntil(promise),
    },
  )
  private readonly model = resolveEdgeModel(this.env.DEEPSEEK_MODEL)
  private readonly activeTurns = new Map<SessionId, ActiveTurn>()
  private readonly sessionListMetadata = new Map<SessionId, SessionListMetadata>()
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
  private readonly apiFetch = toFetchHandler(this.api).fetch

  /** Serve session routes forwarded by the entry Worker. */
  override async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      const edgeRemote = await handleEdgeRemote(request)
      if (edgeRemote !== undefined) return edgeRemote
      if (url.pathname === '/api/events.mux' || url.pathname === '/api/events.host') {
        return await this.openDownlink(request, url.pathname === '/api/events.mux' ? 'mux' : 'host')
      }
      if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/sessions')) {
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
        return this.cancelTurn(route.sessionId)
      }

      throw new EdgeHttpError(404, 'Session route not found.')
    } catch (error) {
      await discardUnreadRequestBody(request)
      return errorResponse(error)
    }
  }

  /** Reject client messages because both upstream WebSockets are downlink-only. */
  override webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer): void {
    if (this.closeExpiredDownlink(socket, Date.now())) return
    socket.close(1008, 'downlink only')
  }

  /** Close a broken downstream without affecting other subscribers. */
  override webSocketError(socket: WebSocket, error: unknown): void {
    console.error('dsh-edge downstream WebSocket failed.', error)
    socket.close(1011, 'downstream failure')
  }

  /** End hibernating downlinks when the owner session used to open them expires. */
  override async alarm(): Promise<void> {
    const nextExpiry = this.closeExpiredDownlinks()
    if (nextExpiry !== undefined) await this.ctx.storage.setAlarm(nextExpiry)
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
        for (const queue of baseline.queues) {
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

  private publishSessionEvent(sessionId: SessionId, event: SessionEvent): void {
    this.broadcast('mux', { type: 'session/event', sessionId, event })
    const previous = this.sessionListMetadata.get(sessionId) ?? INITIAL_SESSION_LIST_METADATA
    const next = applySessionListMetadata(previous, event)
    if (next === previous) return
    this.sessionListMetadata.set(sessionId, next)
    this.broadcast('mux', {
      type: 'session/projection',
      sessionId,
      key: 'sessionListMetadata',
      value: next,
      seq: event.seq,
    })
  }

  private rememberSessionListMetadata(session: EdgeApiSessionSummary): void {
    this.sessionListMetadata.set(session.id, {
      blank: session.blank,
      lastPromptAt: session.lastPromptAt,
    })
  }

  private publishSessionQueue(sessionId: SessionId, items: QueuedInboxItem[]): void {
    this.broadcast('mux', { type: 'session/queue', sessionId, items })
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
    const { commandTimeoutPolicy } = resolveEdgeDeploymentConfig(this.env)
    const claimed = await this.claimTurn(sessionId)

    const { stream, completion } = createLiveSessionEventStream(
      publish => this.runClaimedTurn({
        claimed,
        commandTimeoutPolicy,
        mode: 'queue',
        content: [{ type: 'text', text: message }],
        publish,
      }),
      (error) => {
        console.error('dsh-edge turn transport failed.', error)
      },
    )
    this.ctx.waitUntil(completion.catch(() => undefined))

    return new Response(stream, {
      status: 200,
      headers: edgeEventStreamHeaders(corsHeaders()),
    })
  }

  private async startApiPrompt(input: {
    sessionId: SessionId
    mode: 'queue' | 'steer'
    content: ContentBlock[]
    rpcId: RpcId
    clientTimeZone?: string
  }): Promise<void> {
    if (messageTextByteLength(input.content.filter(
      (part): part is Extract<ContentBlock, { type: 'text' }> => part.type === 'text',
    )) > MAX_MESSAGE_TEXT_BYTES) {
      throw new EdgeHttpError(
        413,
        `Prompt text is limited to ${MAX_MESSAGE_TEXT_BYTES} UTF-8 bytes.`,
      )
    }
    while (true) {
      const active = this.activeTurns.get(input.sessionId)
      if (active !== undefined) {
        await active.admissionReady
        if (this.activeTurns.get(input.sessionId) === active
          && active.accepting
          && active.admit !== undefined) {
          await active.admit({
            mode: input.mode,
            content: input.content,
            rpcId: input.rpcId,
            ...input.clientTimeZone === undefined
              ? {}
              : { clientTimeZone: input.clientTimeZone },
          })
          return
        }
        await active.releaseComplete
        continue
      }

      const { commandTimeoutPolicy } = resolveEdgeDeploymentConfig(this.env)
      let claimed: Awaited<ReturnType<DshEdgeInstance['claimTurn']>>
      try {
        claimed = await this.claimTurn(input.sessionId)
      } catch (error) {
        if (error instanceof EdgeSessionStoreError && error.code === 'BUSY') continue
        throw error
      }
      const running = this.runClaimedTurn({
        claimed,
        commandTimeoutPolicy,
        mode: input.mode,
        content: input.content,
        rpcId: input.rpcId,
        ...input.clientTimeZone === undefined
          ? {}
          : { clientTimeZone: input.clientTimeZone },
      })
      this.ctx.waitUntil(running.catch((error: unknown) => {
        console.error('dsh-edge upstream protocol turn failed.', error)
      }))
      await claimed.turn.admissionReady
      if (!claimed.turn.wasAdmitted) await running
      return
    }
  }

  private updateQueue(
    sessionId: SessionId,
    itemId: MessageId,
    action: QueueAction,
  ): 'accepted' | 'queue-item-not-found' | 'steer-unavailable' | 'queue-edit-attachment-invalid' {
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
      agent.inbox.replace(itemId, freezeMessage({ ...message, content: action.content }))
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
    if (this.activeTurns.has(sessionId)) {
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
      await handle.dispose().catch((error: unknown) => {
        console.error('dsh-edge failed to release the turn agent.', error)
      })
      const active = this.activeTurns.get(sessionId)
      if (active?.turnId === turn.turnId) this.activeTurns.delete(sessionId)
      turn.resolveReleaseComplete()
      this.publishRunning(sessionId, false)
    }
  }

  private async runTurn(input: {
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

  private cancelTurn(sessionId: SessionId): Response {
    const active = this.activeTurns.get(sessionId)
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
    if (active === undefined) return false
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
    if ((channel !== 'mux' && channel !== 'host')
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
