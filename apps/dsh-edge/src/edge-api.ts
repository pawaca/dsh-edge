/** Upstream ApiProxy implementation over one Cloudflare DSH instance. */

import type {
  ApiProxy,
  CredentialView,
  HistoryEntry,
  ModelProviderGroup,
  PromptContentPart,
  QueueAction,
  RpcError,
  RpcRequest,
  RpcResponse,
  SessionProjectionsBlock,
  SessionSummary,
  WorkspaceId,
  WorkspaceView,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { EDGE_SYSTEM_PROMPT } from './agent.ts'
import type { EdgeDeploymentProfile } from './deployment.ts'
import type { EdgeApiSessionSummary, EdgeSessionStore } from './session-store.ts'
import { EdgeSessionStoreError } from './session-store.ts'
import {
  EDGE_WORKSPACE_ID,
  EDGE_WORKSPACE_PATH,
  EdgeWorkspaceStoreError,
} from './edge-workspace-store.ts'

const EDGE_PROVIDER = 'deepseek-official'
const DEFAULT_HISTORY_MESSAGES = 50
/** Maximum UTF-8 text accepted by message-bearing prompt and queue-edit operations. */
export const MAX_MESSAGE_TEXT_BYTES = 65_536

const textEncoder = new TextEncoder()

/**
 * Count the UTF-8 bytes carried by one text-only message operation.
 * @param content - Prompt or queue-edit text blocks.
 * @returns The combined encoded byte length.
 */
export function messageTextByteLength(
  content: readonly Extract<PromptContentPart, { type: 'text' }>[],
): number {
  return content.reduce((total, part) => total + textEncoder.encode(part.text).byteLength, 0)
}

/** Runtime operations that turn typed API calls into one DO's live work. */
export interface EdgeApiRuntime {
  readonly sessions: EdgeSessionStore
  readonly model: string
  readonly version: string
  deploymentProfile(): EdgeDeploymentProfile
  describeCredential(ref: string): Promise<CredentialView>
  isRunning(sessionId: SessionId): boolean
  prompt(input: {
    sessionId: SessionId
    mode: 'queue' | 'steer'
    content: Extract<PromptContentPart, { type: 'text' }>[]
    rpcId: RpcRequest<unknown>['rpcId']
    clientTimeZone?: string
  }): Promise<void>
  updateQueue(
    sessionId: SessionId,
    itemId: MessageId,
    action: QueueAction,
  ): 'accepted' | 'queue-item-not-found' | 'steer-unavailable'
  cancel(sessionId: SessionId): boolean
  workspaceList(sessions: readonly EdgeApiSessionSummary[]): Promise<{
    items: WorkspaceView[]
    archivedSessionIds: SessionId[]
  }>
  workspaceCreate(path: string): Promise<{ workspace: WorkspaceView; created: boolean }>
  workspaceRename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>
  workspaceDelete(workspaceId: WorkspaceId): Promise<void>
  workspaceInsertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<WorkspaceId[]>
  workspaceInsertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView>
  archiveSession(sessionId: SessionId): Promise<SessionId[]>
  sessionCreated(session: EdgeApiSessionSummary): void
  sessionAttached(session: EdgeApiSessionSummary, workspaceId: WorkspaceId): Promise<void>
  workspaceForSession(sessionId: SessionId): Promise<WorkspaceId | undefined>
  sessionEvent(sessionId: SessionId, event: SessionEvent): void
}

/** Build the typed upstream API for one isolated Edge instance. */
export function createEdgeApi(runtime: EdgeApiRuntime): ApiProxy {
  const modelGroups = (): ModelProviderGroup[] => [{
    id: EDGE_PROVIDER,
    name: 'DeepSeek',
    models: [{ id: runtime.model, name: runtime.model }],
  }]

  const api: ApiProxy = {
    sessions: {
      async list(request) {
        const sessions = await runtime.sessions.listApiSessions()
        return ok(request, { items: sessions.map(summary => sessionSummary(runtime, summary)) })
      },

      async search(request, signal) {
        try {
          return ok(request, await runtime.sessions.searchApiSessions(request.payload.query, signal))
        } catch (error) {
          if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
            return fail(request, {
              code: 'cancelled',
              message: 'Session search was aborted.',
              details: {},
            })
          }
          return fail(request, {
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          })
        }
      },

      async create(request) {
        const { workspaceId, cwd, sessionId, agentPreset } = request.payload
        if (workspaceId !== undefined && workspaceId !== EDGE_WORKSPACE_ID) {
          return fail(request, {
            code: 'workspace-not-found',
            message: `Workspace "${workspaceId}" is not available in this Edge instance.`,
            details: { workspaceId },
          })
        }
        const available = await runtime.workspaceList(await runtime.sessions.listApiSessions())
        if (workspaceId !== undefined) {
          if (!available.items.some(item => item.workspaceId === workspaceId)) {
            return fail(request, {
              code: 'workspace-not-found',
              message: `Workspace "${workspaceId}" is not available in this Edge instance.`,
              details: { workspaceId },
            })
          }
        }
        if (cwd !== undefined && cwd !== EDGE_WORKSPACE_PATH) {
          return fail(request, {
            code: 'workspace-invalid-path',
            message: `Edge sessions must use ${EDGE_WORKSPACE_PATH}.`,
            details: { path: cwd },
          })
        }
        if (agentPreset !== undefined && agentPreset !== 'dsh-edge') {
          return fail(request, {
            code: 'agent-preset-not-found',
            message: `Agent preset "${agentPreset}" is not available in this Edge instance.`,
            details: { agentPreset, available: ['dsh-edge'] },
          })
        }
        try {
          const created = await runtime.sessions.createBlankSession({
            model: runtime.model,
            ...sessionId === undefined ? {} : { sessionId },
          })
          const summary = (await runtime.sessions.listApiSessions())
            .find(item => item.id === created.sessionId)
          if (summary !== undefined) {
            if (created.created) runtime.sessionCreated(summary)
            if (workspaceId !== undefined) {
              const attachmentError = await attachPublishedSession(
                created.sessionId,
                workspaceId,
                'created',
                () => runtime.sessionAttached(summary, workspaceId),
              )
              if (attachmentError !== undefined) return fail(request, attachmentError)
            }
          }
          return ok(request, {
            sessionId: created.sessionId,
            agentPreset: created.agentPreset,
          })
        } catch (error) {
          return sessionFailure(request, error, sessionId)
        }
      },

      async history(request) {
        const { sessionId, beforeSeq, maxMessages } = request.payload
        try {
          const page = await runtime.sessions.readHistoryPage(
            sessionId,
            beforeSeq,
            maxMessages ?? DEFAULT_HISTORY_MESSAGES,
          )
          const entries: HistoryEntry[] = page.events.map(event => ({ event }))
          return ok(request, {
            events: entries,
            hasMore: page.hasMore,
            ...beforeSeq === undefined
              ? { projections: summaryProjections(page.summary) }
              : {},
          })
        } catch (error) {
          return sessionFailure(request, error, sessionId)
        }
      },

      async models(request) {
        try {
          await runtime.sessions.requireSession(request.payload.sessionId)
          return ok(request, {
            current: { provider: EDGE_PROVIDER, model: runtime.model },
            routable: true,
            groups: modelGroups(),
            failures: [],
          })
        } catch (error) {
          return sessionFailure(request, error, request.payload.sessionId)
        }
      },

      async selectModel(request) {
        const { sessionId, provider, model, reasoningEffort } = request.payload
        if (provider !== EDGE_PROVIDER || model !== runtime.model || reasoningEffort !== undefined) {
          return fail(request, {
            code: 'model-unavailable',
            message: `This Edge instance serves only ${EDGE_PROVIDER}/${runtime.model}.`,
            details: { provider, model },
          })
        }
        try {
          await runtime.sessions.requireSession(sessionId)
          return ok(request, { selected: { provider, model } })
        } catch (error) {
          return sessionFailure(request, error, sessionId)
        }
      },

      async rename(request) {
        const { sessionId, title } = request.payload
        try {
          const renamed = await runtime.sessions.renameSession(sessionId, title, runtime.model)
          if (renamed.publishRequired) runtime.sessionEvent(sessionId, renamed.event)
          return ok(request, { title: renamed.title, seq: renamed.event.seq })
        } catch (error) {
          return sessionFailure(request, error, sessionId)
        }
      },

      async fork(request) {
        const { sessionId, atSeq } = request.payload
        try {
          const workspaceId = await runtime.workspaceForSession(sessionId)
          const child = await runtime.sessions.forkSession(sessionId, atSeq, runtime.model)
          runtime.sessionCreated(child)
          if (workspaceId !== undefined) {
            const attachmentError = await attachPublishedSession(
              child.id,
              workspaceId,
              'forked',
              () => runtime.sessionAttached(child, workspaceId),
            )
            if (attachmentError !== undefined) return fail(request, attachmentError)
          }
          return ok(request, { sessionId: child.id })
        } catch (error) {
          return sessionFailure(request, error, sessionId)
        }
      },

      async prompt(request) {
        const { sessionId, mode, content, clientTimeZone } = request.payload
        const zone = canonicalClientTimeZone(clientTimeZone)
        if (clientTimeZone !== undefined && zone === undefined) {
          return fail(request, {
            code: 'invalid-time-zone',
            message: 'clientTimeZone must be UTC or a valid IANA Area/Location name.',
            details: { value: clientTimeZone },
          })
        }
        if (content.some(part => part.type === 'image')) {
          return fail(request, {
            code: 'attachment-error',
            message: 'Image attachments are not available in this Edge instance.',
            details: { reason: 'EDGE_ATTACHMENTS_UNAVAILABLE' },
          })
        }
        const textContent = content as Extract<PromptContentPart, { type: 'text' }>[]
        if (messageTextByteLength(textContent) > MAX_MESSAGE_TEXT_BYTES) {
          return fail(request, {
            code: 'attachment-error',
            message: `Prompt text is limited to ${MAX_MESSAGE_TEXT_BYTES} UTF-8 bytes.`,
            details: { reason: 'PROMPT_TEXT_TOO_LARGE' },
          })
        }
        try {
          await runtime.prompt({
            sessionId,
            mode,
            content: textContent,
            rpcId: request.rpcId,
            ...zone === undefined ? {} : { clientTimeZone: zone },
          })
          return ok(request, { accepted: true as const })
        } catch (error) {
          return sessionFailure(request, error, sessionId)
        }
      },

      attachment: unsupported,
      updateQueue(request) {
        const { sessionId, itemId, action } = request.payload
        if (action.kind === 'edit' && action.content.some(block => block.type !== 'text')) {
          return Promise.resolve(fail(request, {
            code: 'attachment-error',
            message: 'Queue edits accept text content only in this Edge instance.',
            details: { reason: 'QUEUE_EDIT_NON_TEXT' },
          }))
        }
        if (action.kind === 'edit'
          && messageTextByteLength(
            action.content as Extract<PromptContentPart, { type: 'text' }>[],
          ) > MAX_MESSAGE_TEXT_BYTES) {
          return Promise.resolve(fail(request, {
            code: 'attachment-error',
            message: `Queue edit text is limited to ${MAX_MESSAGE_TEXT_BYTES} UTF-8 bytes.`,
            details: { reason: 'QUEUE_EDIT_TEXT_TOO_LARGE' },
          }))
        }
        const outcome = runtime.updateQueue(sessionId, itemId, action)
        if (outcome === 'queue-item-not-found') {
          return Promise.resolve(fail(request, {
            code: 'queue-item-not-found',
            message: 'The queued item is no longer pending.',
            details: { itemId },
          }))
        }
        if (outcome === 'steer-unavailable') {
          return Promise.resolve(fail(request, {
            code: 'steer-unavailable',
            message: 'The current turn no longer accepts steering.',
            details: { itemId },
          }))
        }
        return Promise.resolve(ok(request, { accepted: true as const }))
      },

      cancel(request) {
        if (!runtime.cancel(request.payload.sessionId)) {
          return Promise.resolve(fail(request, {
            code: 'agent-busy',
            message: 'The session has no active turn in this Edge instance.',
            details: { reason: 'not-running' },
          }))
        }
        return Promise.resolve(ok(request, { accepted: true as const }))
      },
    },

    subagents: {
      list: request => Promise.resolve(ok(request, { entries: [], parentAvailable: false })),
      history: unsupported,
      prompt: unsupported,
      interrupt: unsupported,
    },

    host: {
      async describe(request) {
        return ok(request, {
          version: runtime.version,
          cwd: EDGE_WORKSPACE_PATH,
          provider: EDGE_PROVIDER,
          model: runtime.model,
          attachedSessions: await runtime.sessions.attachedSessionCount(),
          canOpenPath: false,
        })
      },
      pickDirectory: unsupported,
      listDirectory: unsupported,
      createDirectory: unsupported,
      openPath: unsupported,
    },

    workspace: {
      async list(request) {
        const sessions = await runtime.sessions.listApiSessions()
        return ok(request, await runtime.workspaceList(sessions))
      },
      async create(request) {
        try {
          return ok(request, await runtime.workspaceCreate(request.payload.path))
        } catch (error) {
          return workspaceFailure(request, error, undefined, undefined, undefined, request.payload.path)
        }
      },
      async rename(request) {
        const { workspaceId, title } = request.payload
        try {
          return ok(request, {
            workspace: await runtime.workspaceRename(workspaceId, title.trim()),
          })
        } catch (error) {
          return workspaceFailure(request, error, workspaceId)
        }
      },
      async delete(request) {
        const { workspaceId } = request.payload
        try {
          await runtime.workspaceDelete(workspaceId)
          return ok(request, { deleted: true as const })
        } catch (error) {
          return workspaceFailure(request, error, workspaceId)
        }
      },
      async insertBefore(request) {
        const { workspaceId, beforeWorkspaceId } = request.payload
        try {
          return ok(request, {
            workspaceIds: await runtime.workspaceInsertBefore(workspaceId, beforeWorkspaceId),
          })
        } catch (error) {
          return workspaceFailure(request, error, workspaceId)
        }
      },
      async insertSessionBefore(request) {
        const { workspaceId, sessionId, beforeSessionId } = request.payload
        try {
          return ok(request, {
            workspace: await runtime.workspaceInsertSessionBefore(
              workspaceId,
              sessionId,
              beforeSessionId,
            ),
          })
        } catch (error) {
          return workspaceFailure(request, error, workspaceId, sessionId, beforeSessionId)
        }
      },
      async archiveSession(request) {
        const { sessionId } = request.payload
        try {
          return ok(request, {
            archivedSessionIds: await runtime.archiveSession(sessionId),
          })
        } catch (error) {
          return sessionFailure(request, error, sessionId)
        }
      },
    },

    skills: {
      list: request => Promise.resolve(ok(request, { skills: [] })),
    },

    agentPresets: {
      list: request => Promise.resolve(ok(request, {
        presets: [{
          id: 'dsh-edge',
          trust: 'system' as const,
          isDefault: true,
          name: 'DSH Edge',
          description: 'DeepSeek Harness running in a Cloudflare Durable Object.',
        }],
        authorable: false,
        hasDocument: false,
      })),
      select(request) {
        if (request.payload.agentPreset !== 'dsh-edge') {
          return Promise.resolve(fail(request, {
            code: 'agent-preset-not-found',
            message: `Agent preset "${request.payload.agentPreset}" is not available.`,
            details: { agentPreset: request.payload.agentPreset, available: ['dsh-edge'] },
          }))
        }
        return Promise.resolve(ok(request, { agentPreset: 'dsh-edge' }))
      },
      read(request) {
        if (request.payload.agentPreset !== 'dsh-edge') {
          return Promise.resolve(fail(request, {
            code: 'agent-preset-not-found',
            message: `Agent preset "${request.payload.agentPreset}" is not available.`,
            details: { agentPreset: request.payload.agentPreset, available: ['dsh-edge'] },
          }))
        }
        try {
          return Promise.resolve(ok(request, {
            agentPreset: 'dsh-edge',
            trust: 'system' as const,
            name: 'DSH Edge',
            description: 'DeepSeek Harness running in a Cloudflare Durable Object.',
            content: edgeAgentPresetContent(runtime, runtime.deploymentProfile()),
          }))
        } catch (error) {
          return Promise.resolve(fail(request, {
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          }))
        }
      },
      copy: unsupported,
      openDocument: unsupported,
      remove: unsupported,
    },

    goals: {
      create: unsupported,
      edit: unsupported,
      pause: unsupported,
      resume: unsupported,
      complete: unsupported,
      clear: unsupported,
    },

    settings: {
      describe: request => Promise.resolve(ok(request, {
        writable: false,
        hasDocument: false,
        namespaces: [],
      })),
      openDocument: unsupported,
      update: unsupported,
      replace: unsupported,
      mutate: unsupported,
    },

    credentials: {
      async describe(request) {
        const entries = await Promise.all(request.payload.refs.map(async ref => (
          [ref, await runtime.describeCredential(ref)] as const
        )))
        return ok(request, { credentials: Object.fromEntries(entries) })
      },
      set: unsupported,
      unset: unsupported,
    },

    llm: {
      providers: request => Promise.resolve(ok(request, {
        providers: [{
          provider: EDGE_PROVIDER,
          displayName: 'DeepSeek',
          settingsNs: 'llm-deepseek',
          settingsPath: [],
          active: true,
          declared: false,
        }],
      })),
      models: request => Promise.resolve(ok(request, {
        groups: modelGroups(),
        failures: [],
      })),
      discoverModels: unsupported,
    },

    events: {
      mux: (_request, _signal) => emptyFrames(),
      host: (_request, _signal) => emptyFrames(),
    },

    downloads: {
      sessionLog: () => Promise.resolve(new Response('Session export is unavailable on Edge.', {
        status: 501,
      })),
    },

    respond: () => Promise.resolve({ accepted: false, reason: 'not-pending' }),
  }
  return api
}

/** Render the programmatic Edge agent graph through the upstream composition viewer. */
function edgeAgentPresetContent(
  runtime: EdgeApiRuntime,
  deployment: EdgeDeploymentProfile,
): string {
  return [
    '# Effective dsh-edge composition (read-only)',
    '# Projected from the programmatic Worker runtime; this is not an editable agent.cordis.yml.',
    'preset:',
    '  id: dsh-edge',
    '  trust: system',
    'release:',
    `  version: ${yamlString(runtime.version)}`,
    `  deploymentId: ${yamlString(deployment.deploymentId)}`,
    'runtime:',
    '  platform: cloudflare-workers',
    `  storage: ${yamlString(deployment.storage)}`,
    `  shell: ${yamlString(deployment.shell)}`,
    '  workspace: /workspace',
    'agent:',
    '  loop: "@deepseek-ai/dsh-agent-loop"',
    '  registry: "@deepseek-ai/dsh-agent"',
    '  sessionStore: "@deepseek-ai/dsh-session"',
    `  systemPrompt: ${yamlString(EDGE_SYSTEM_PROMPT)}`,
    'model:',
    `  provider: ${yamlString(EDGE_PROVIDER)}`,
    `  id: ${yamlString(runtime.model)}`,
    `  baseURL: ${yamlString(deployment.baseURL)}`,
    `  reasoningEffort: ${yamlString(deployment.reasoningEffort)}`,
    `  maxOutputTokens: ${String(deployment.maxTokens)}`,
    `  streamIdleTimeoutMs: ${String(deployment.streamIdleTimeoutMs)}`,
    '  credential:',
    '    ref: DEEPSEEK_API_KEY',
    `    configured: ${String(deployment.apiKeyConfigured)}`,
    '    persisted: false',
    'tools:',
    '  - id: bash',
    '    runtime: just-bash',
    '    filesystem: /workspace',
    `    defaultTimeoutMs: ${String(deployment.commandTimeoutPolicy.defaultTimeoutMs)}`,
    `    maxTimeoutMs: ${String(deployment.commandTimeoutPolicy.maxTimeoutMs)}`,
    '  - id: web_search',
    '    provider: deepseek-official',
    `    baseURL: ${yamlString(deployment.searchBaseURL)}`,
    '    credentialRef: DEEPSEEK_API_KEY',
    '    maxResults: 8',
    '    webFetchEnabled: false',
  ].join('\n') + '\n'
}

/** Quote a string as a JSON scalar, which is also a valid YAML scalar. */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

function sessionSummary(
  runtime: EdgeApiRuntime,
  summary: EdgeApiSessionSummary,
): SessionSummary {
  return {
    sessionId: summary.id,
    updatedAt: summary.updatedAt,
    running: runtime.isRunning(summary.id),
    blank: summary.blank,
    ...summary.parentSessionId === undefined
      ? {}
      : { parentSessionId: summary.parentSessionId },
    ...summary.origin === undefined ? {} : { origin: summary.origin },
    ...summary.cwd === undefined ? {} : { cwd: summary.cwd },
    ...summary.agentPreset === undefined ? {} : { agentPreset: summary.agentPreset },
    projections: summaryProjections(summary),
  }
}

function summaryProjections(summary: EdgeApiSessionSummary): SessionProjectionsBlock {
  return {
    asOfSeq: summary.lastSeq,
    values: {
      sessionListMetadata: {
        blank: summary.blank,
        lastPromptAt: summary.lastPromptAt,
      },
      ...summary.title === null ? {} : { title: summary.title },
    },
  }
}

function canonicalClientTimeZone(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const profile = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/
  if (value.length === 0 || value.trim() !== value
    || (value !== 'UTC' && !profile.test(value))) return undefined
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions().timeZone
    return canonical === 'UTC' || profile.test(canonical) ? canonical : undefined
  } catch {
    return undefined
  }
}

function workspaceFailure<T>(
  request: RpcRequest<unknown>,
  error: unknown,
  workspaceId: WorkspaceId | undefined,
  sessionId?: SessionId,
  beforeSessionId?: SessionId,
  path?: string,
): RpcResponse<T> {
  if (error instanceof EdgeWorkspaceStoreError) {
    if (error.code === 'NOT_FOUND' && workspaceId !== undefined) {
      return fail(request, {
        code: 'workspace-not-found',
        message: error.message,
        details: { workspaceId },
      })
    }
    if (error.code === 'INVALID_PATH') {
      return fail(request, {
        code: 'workspace-invalid-path',
        message: error.message,
        details: { path: path ?? EDGE_WORKSPACE_PATH },
      })
    }
    if (error.code === 'MOVE_INVALID' && workspaceId !== undefined && sessionId !== undefined) {
      return fail(request, {
        code: 'workspace-move-invalid',
        message: error.message,
        details: {
          workspaceId,
          sessionId,
          ...beforeSessionId === undefined ? {} : { beforeSessionId },
        },
      })
    }
  }
  return fail(request, {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  })
}

/**
 * Capture post-durability Workspace completion without losing the Session id.
 * @param sessionId - Session that already exists durably.
 * @param workspaceId - Workspace the completion step must account for.
 * @param operation - User-visible creation verb used by the diagnostic.
 * @param attach - Publication and attachment work that may still fail.
 * @returns The upstream recoverable error, or `undefined` after completion.
 */
export async function attachPublishedSession(
  sessionId: SessionId,
  workspaceId: WorkspaceId,
  operation: 'created' | 'forked',
  attach: () => Promise<unknown>,
): Promise<RpcError | undefined> {
  try {
    await attach()
    return undefined
  } catch (error) {
    return {
      code: 'workspace-attach-failed',
      message: `Session "${sessionId}" was ${operation} but could not attach to workspace "${workspaceId}": ${String(error)}`,
      details: { sessionId, workspaceId },
    }
  }
}

function ok<P, T>(request: RpcRequest<P>, value: T): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: true, value } }
}

function fail<P, T>(request: RpcRequest<P>, error: RpcError): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: false, error } }
}

function unsupported<T>(request: RpcRequest<unknown>): Promise<RpcResponse<T>> {
  return Promise.resolve(fail(request, {
    code: 'internal',
    message: 'This capability is not available in the Edge runtime.',
    details: {},
  }))
}

function sessionFailure<T>(
  request: RpcRequest<unknown>,
  error: unknown,
  sessionId: SessionId | undefined,
): RpcResponse<T> {
  if (error instanceof EdgeSessionStoreError) {
    if (error.code === 'NOT_FOUND' && sessionId !== undefined) {
      return fail(request, {
        code: 'session-not-found',
        message: error.message,
        details: { sessionId },
      })
    }
    if (error.code === 'BUSY') {
      return fail(request, {
        code: 'agent-busy',
        message: error.message,
        details: { reason: 'running' },
      })
    }
    if (error.code === 'FORK_UNAVAILABLE' && sessionId !== undefined) {
      return fail(request, {
        code: 'fork-unavailable',
        message: error.message,
        details: { sessionId },
      })
    }
    if (error.code === 'TITLE_INVALID' && sessionId !== undefined) {
      return fail(request, {
        code: 'title-invalid',
        message: error.message,
        details: { sessionId },
      })
    }
  }
  return fail(request, {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  })
}

async function* emptyFrames<T>(): AsyncGenerator<T> {}
