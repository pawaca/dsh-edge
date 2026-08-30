/** Upstream ApiProxy implementation over one Cloudflare DSH instance. */

import {
  AttachmentError,
  admitEncodedImages,
  type ImageAttachmentRef,
  type ImageAttachmentLimits,
} from '@deepseek-ai/dsh-attachment'
import type {
  ApiProxy,
  CredentialView,
  HistoryEntry,
  PromptContentPart,
  QueueAction,
  RpcError,
  RpcRequest,
  RpcResponse,
  SessionProjectionsBlock,
  SessionSummary,
  SettingsNamespaceView,
  WorkspaceId,
  WorkspaceView,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  SettingsConflictError,
  type SettingsDescriptor,
  type SettingsPathOp,
} from '@deepseek-ai/dsh-settings'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalService } from '@deepseek-ai/dsh-goal'
import type { GoalRef } from '@deepseek-ai/dsh-host-apiproxy/api'
import { EDGE_SYSTEM_PROMPT } from './agent.ts'
import type { EdgeDeploymentProfile } from './deployment.ts'
import { EDGE_DO_ATTACHMENT_MAX_STORED_BYTES } from './edge-attachment-store.ts'
import type { EdgeApiSessionSummary, EdgeSessionStore } from './session-store.ts'
import { EdgeSessionCwdConflictError, EdgeSessionStoreError } from './session-store.ts'
import {
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceUnknownSessionError,
} from '@deepseek-ai/dsh-workspace'

const EDGE_WORKSPACE_PATH = '/workspace'

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
  readonly imageLimits?: ImageAttachmentLimits
  deploymentProfile(): EdgeDeploymentProfile
  describeCredential(ref: string): Promise<CredentialView>
  setCredential(ref: string, value: string): Promise<void>
  unsetCredential(ref: string): Promise<void>
  settingsWritable(): Promise<boolean>
  settingsHasDocument(): Promise<boolean>
  describeSettings(): Promise<SettingsDescriptor[]>
  updateSettings(ns: string, patch: object, expectedRevision?: number): Promise<SettingsDescriptor | undefined>
  replaceSettings(ns: string, section: object, expectedRevision?: number): Promise<SettingsDescriptor | undefined>
  mutateSettings(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<SettingsDescriptor | undefined>
  listConfigurableProviders(): Promise<{
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: readonly string[]
    active: boolean
    declared?: boolean
  }[]>
  listLlmProviders(): Promise<{ id: string; name: string }[]>
  isRunning(sessionId: SessionId): boolean
  prompt(input: {
    sessionId: SessionId
    mode: 'queue' | 'steer'
    content: ContentBlock[]
    rpcId: RpcRequest<unknown>['rpcId']
    clientTimeZone?: string
  }): Promise<void>
  updateQueue(
    sessionId: SessionId,
    itemId: MessageId,
    action: QueueAction,
  ): 'accepted' | 'queue-item-not-found' | 'steer-unavailable' | 'queue-edit-attachment-invalid'
  cancel(sessionId: SessionId): boolean
  workspaceList(): Promise<{
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
  const imageMutationChains = new Map<SessionId, Promise<void>>()
  const serializeImageMutation = <T>(sessionId: SessionId, operation: () => Promise<T>) => {
    const result = (imageMutationChains.get(sessionId) ?? Promise.resolve()).then(operation)
    const tail = result.then(() => undefined, () => undefined)
    imageMutationChains.set(sessionId, tail)
    return result.finally(() => {
      if (imageMutationChains.get(sessionId) === tail) imageMutationChains.delete(sessionId)
    })
  }
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
        let resolvedCwd = cwd
        if (workspaceId !== undefined) {
          const available = await runtime.workspaceList()
          const workspace = available.items.find(item => item.workspaceId === workspaceId)
          if (workspace === undefined) {
            return fail(request, {
              code: 'workspace-not-found',
              message: `Workspace "${workspaceId}" is not available in this Edge instance.`,
              details: { workspaceId },
            })
          }
          resolvedCwd = workspace.path
        }
        if (resolvedCwd !== undefined && !isValidWorkspacePath(resolvedCwd)) {
          return fail(request, {
            code: 'workspace-invalid-path',
            message: 'A path below /workspace/ is required.',
            details: { path: resolvedCwd },
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
            ...resolvedCwd === undefined ? {} : { cwd: resolvedCwd },
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
              ? { projections: summaryProjections(page.summary, runtime.imageLimits, runtime.sessions.projectionSnapshot(sessionId, page.events)?.values) }
              : {},
          })
        } catch (error) {
          return sessionFailure(request, error, sessionId)
        }
      },

      async models(request) {
        try {
          const [current, catalog] = await Promise.all([
            runtime.sessions.modelSelection(request.payload.sessionId, runtime.model),
            runtime.sessions.modelCatalog(),
          ])
          return ok(request, {
            current,
            routable: true,
            groups: catalog.groups,
            failures: catalog.failures,
          })
        } catch (error) {
          return sessionFailure(request, error, request.payload.sessionId)
        }
      },

      async selectModel(request) {
        const { sessionId, provider, model, reasoningEffort } = request.payload
        return await serializeImageMutation(sessionId, async () => {
          try {
            const selected = await runtime.sessions.selectModel(sessionId, {
              provider,
              model,
              ...reasoningEffort === undefined ? {} : { reasoningEffort },
            })
            return ok(request, { selected })
          } catch (error) {
            if (!(error instanceof EdgeSessionStoreError)) {
              return fail(request, {
                code: 'model-unavailable',
                message: error instanceof Error ? error.message : String(error),
                details: { provider, model },
              })
            }
            return sessionFailure(request, error, sessionId)
          }
        })
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
        const textContent = content.filter(
          (part): part is Extract<PromptContentPart, { type: 'text' }> => part.type === 'text',
        )
        if (messageTextByteLength(textContent) > MAX_MESSAGE_TEXT_BYTES) {
          return fail(request, {
            code: 'attachment-error',
            message: `Prompt text is limited to ${MAX_MESSAGE_TEXT_BYTES} UTF-8 bytes.`,
            details: { reason: 'PROMPT_TEXT_TOO_LARGE' },
          })
        }
        const hasImage = content.some(part => part.type === 'image')
        const admit = async (): Promise<RpcResponse<{ accepted: true }>> => {
          try {
            let durable: ContentBlock[]
            if (!hasImage) {
              durable = textContent.map(part => ({ type: 'text', text: part.text }))
            } else {
              const attachments = await runtime.sessions.attachmentStore()
              if (attachments === undefined) {
                return fail(request, {
                  code: 'attachment-error',
                  message: 'Image attachments are not available in this Edge instance.',
                  details: { reason: 'EDGE_ATTACHMENTS_UNAVAILABLE' },
                })
              }
              if (!await runtime.sessions.modelSupportsImages(sessionId, runtime.model)) {
                return fail(request, {
                  code: 'attachment-error',
                  message: 'The selected model does not support image input.',
                  details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
                })
              }
              const refs = await admitEncodedImages(
                attachments,
                content.filter(
                  (part): part is Extract<PromptContentPart, { type: 'image' }> =>
                    part.type === 'image',
                ),
              )
              let nextImage = 0
              durable = content.map(part => part.type === 'text'
                ? { type: 'text', text: part.text }
                : { type: 'image', attachment: refs[nextImage++]! })
            }
            await runtime.prompt({
              sessionId,
              mode,
              content: durable,
              rpcId: request.rpcId,
              ...zone === undefined ? {} : { clientTimeZone: zone },
            })
            return ok(request, { accepted: true as const })
          } catch (error) {
            if (error instanceof AttachmentError) {
              return fail(request, {
                code: 'attachment-error',
                message: error.message,
                details: { reason: error.code },
              })
            }
            return sessionFailure(request, error, sessionId)
          }
        }
        return hasImage ? serializeImageMutation(sessionId, admit) : admit()
      },

      async attachment(request): Promise<RpcResponse<{
        attachment: ImageAttachmentRef
        data: string
      }>> {
        const { sessionId, attachmentId } = request.payload
        try {
          const attachments = await runtime.sessions.attachmentStore()
          if (attachments === undefined) {
            return fail(request, {
              code: 'attachment-error',
              message: 'Image attachments are not available in this Edge instance.',
              details: { reason: 'EDGE_ATTACHMENTS_UNAVAILABLE' },
            })
          }
          const ref = await runtime.sessions.referencedImage(sessionId, String(attachmentId))
          if (ref === undefined) {
            return fail(request, {
              code: 'attachment-error',
              message: 'Image is not referenced by this session.',
              details: { reason: 'ATTACHMENT_NOT_REFERENCED' },
            })
          }
          const stored = await attachments.readImage(ref)
          return ok(request, {
            attachment: stored.ref,
            data: bytesToBase64(stored.data),
          })
        } catch (error) {
          if (error instanceof AttachmentError) {
            return fail(request, {
              code: 'attachment-error',
              message: error.message,
              details: { reason: error.code },
            })
          }
          return sessionFailure(request, error, sessionId)
        }
      },
      updateQueue(request) {
        const { sessionId, itemId, action } = request.payload
        if (action.kind === 'edit'
          && action.content.some(block => block.type !== 'text' && block.type !== 'image')) {
          return Promise.resolve(fail(request, {
            code: 'attachment-error',
            message: 'Queue edits accept text and previously admitted images only.',
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
        if (outcome === 'queue-edit-attachment-invalid') {
          return Promise.resolve(fail(request, {
            code: 'attachment-error',
            message: 'Queue edits may only preserve images already admitted for this pending item.',
            details: { reason: 'QUEUE_EDIT_ATTACHMENT_INVALID' },
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
          home: EDGE_WORKSPACE_PATH,
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
        return ok(request, await runtime.workspaceList())
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
      async read(request) {
        if (request.payload.agentPreset !== 'dsh-edge') {
          return fail(request, {
            code: 'agent-preset-not-found',
            message: `Agent preset "${request.payload.agentPreset}" is not available.`,
            details: { agentPreset: request.payload.agentPreset, available: ['dsh-edge'] },
          })
        }
        try {
          const [catalog, settings, credential] = await Promise.all([
            runtime.sessions.modelCatalog(),
            runtime.describeSettings(),
            runtime.describeCredential('DEEPSEEK_API_KEY'),
          ])
          const deployment = runtime.deploymentProfile()
          const llmSection = settings
            .find(d => d.ns === 'llm-deepseek')
            ?.value as Record<string, string | number | undefined> | undefined
          const liveBaseURL = llmSection?.['baseURL']
          const liveEffort = llmSection?.['reasoningEffort']
          const liveMaxTokens = llmSection?.['maxTokens']
          const liveProfile = {
            ...deployment,
            ...(typeof liveBaseURL === 'string' ? { baseURL: sanitizeProjectedURL(liveBaseURL) } : {}),
            ...(typeof liveEffort === 'string'
              ? { reasoningEffort: liveEffort as typeof deployment.reasoningEffort } : {}),
            ...(typeof liveMaxTokens === 'number' ? { maxTokens: liveMaxTokens } : {}),
            apiKeyConfigured: credential.configured,
            apiKeyPersisted: credential.source === 'do-storage',
          }
          return ok(request, {
            agentPreset: 'dsh-edge',
            trust: 'system' as const,
            name: 'DSH Edge',
            description: 'DeepSeek Harness running in a Cloudflare Durable Object.',
            content: edgeAgentPresetContent(
              runtime,
              liveProfile,
              catalog.groups.flatMap(group => group.models),
            ),
          })
        } catch (error) {
          return fail(request, {
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          })
        }
      },
      copy: unsupported,
      openDocument: unsupported,
      remove: unsupported,
    },

    goals: {
      async create(request) {
        return goalMutate(request, (goals, agent) =>
          goals.create(agent, {
            objective: request.payload.objective,
            ...request.payload.maxGoalRounds !== undefined
              ? { maxGoalRounds: request.payload.maxGoalRounds } : {},
          }))
      },
      async edit(request) {
        return goalMutate(request, (goals, agent) =>
          goals.edit(agent, request.payload.ref, {
            ...request.payload.objective !== undefined ? { objective: request.payload.objective } : {},
            ...request.payload.maxGoalRounds !== undefined ? { maxGoalRounds: request.payload.maxGoalRounds } : {},
          }))
      },
      async pause(request) {
        return goalMutate(request, (goals, agent) => goals.pause(agent, request.payload.ref))
      },
      async resume(request) {
        return goalMutate(request, (goals, agent) => goals.resume(agent, request.payload.ref))
      },
      async complete(request) {
        return goalMutate(request, (goals, agent) => goals.complete(agent, request.payload.ref))
      },
      async clear(request) {
        const agent = runtime.sessions.liveAgent(request.payload.sessionId)
        if (agent === undefined) return fail(request, {
          code: 'session-not-found',
          message: 'Session not found or not live.',
          details: { sessionId: request.payload.sessionId },
        })
        try {
          const goals = agent.ctx.get('goals') as { clear(agent: unknown, ref: unknown): void }
          goals.clear(agent, request.payload.ref)
          return ok(request, { cleared: true as const })
        } catch (error) {
          return fail(request, {
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          })
        }
      },
    },

    settings: {
      async describe(request) {
        const [writable, hasDocument, descriptors] = await Promise.all([
          runtime.settingsWritable(),
          runtime.settingsHasDocument(),
          runtime.describeSettings(),
        ])
        return ok(request, {
          writable,
          hasDocument,
          namespaces: descriptors.map(descriptorToView),
        })
      },
      openDocument: unsupported,
      async update(request) {
        const { ns, patch, expectedRevision } = request.payload
        try {
          const descriptor = await runtime.updateSettings(ns, patch, expectedRevision)
          if (descriptor === undefined) return settingsNotRegistered(request, ns)
          return ok(request, descriptorToView(descriptor))
        } catch (error) {
          return settingsWriteFailure(request, error)
        }
      },
      async replace(request) {
        const { ns, section, expectedRevision } = request.payload
        try {
          const descriptor = await runtime.replaceSettings(ns, section, expectedRevision)
          if (descriptor === undefined) return settingsNotRegistered(request, ns)
          return ok(request, descriptorToView(descriptor))
        } catch (error) {
          return settingsWriteFailure(request, error)
        }
      },
      async mutate(request) {
        const { ns, ops, expectedRevision } = request.payload
        try {
          const descriptor = await runtime.mutateSettings(
            ns,
            ops as readonly SettingsPathOp[],
            expectedRevision,
          )
          if (descriptor === undefined) return settingsNotRegistered(request, ns)
          return ok(request, descriptorToView(descriptor))
        } catch (error) {
          return settingsWriteFailure(request, error)
        }
      },
    },

    credentials: {
      async describe(request) {
        const entries = await Promise.all(request.payload.refs.map(async ref => (
          [ref, await runtime.describeCredential(ref)] as const
        )))
        return ok(request, { credentials: Object.fromEntries(entries) })
      },
      async set(request) {
        const { ref, value } = request.payload
        try {
          await runtime.setCredential(ref, value)
          return ok(request, {})
        } catch (error) {
          return fail(request, {
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          })
        }
      },
      async unset(request) {
        const { ref } = request.payload
        try {
          await runtime.unsetCredential(ref)
          return ok(request, {})
        } catch (error) {
          return fail(request, {
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          })
        }
      },
    },

    llm: {
      async providers(request) {
        const configurable = await runtime.listConfigurableProviders()
        return ok(request, {
          providers: configurable.map(entry => ({
            provider: entry.provider,
            displayName: entry.displayName,
            settingsNs: entry.settingsNs,
            settingsPath: [...entry.settingsPath],
            active: entry.active,
            ...entry.declared === undefined ? {} : { declared: entry.declared },
          })),
        })
      },
      async models(request) {
        return ok(request, await runtime.sessions.modelCatalog())
      },
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
    async function goalMutate(
    request: RpcRequest<{ sessionId: SessionId } & Record<string, unknown>>,
    mutation: (goals: GoalService, agent: Agent) => GoalRef,
  ): Promise<RpcResponse<{ ref: GoalRef }>> {
    const agent = runtime.sessions.liveAgent(request.payload.sessionId)
    if (agent === undefined) return fail(request, {
      code: 'session-not-found',
      message: 'Session not found or not live.',
      details: { sessionId: request.payload.sessionId },
    }) as never
    try {
      const goals = agent.ctx.get('goals') as GoalService
      const ref = mutation(goals, agent)
      return ok(request, { ref }) as never
    } catch (error) {
      return fail(request, {
        code: 'internal',
        message: error instanceof Error ? error.message : String(error),
        details: {},
      })
    }
  }

  return api
}

/** Render the programmatic Edge agent graph through the upstream composition viewer. */
function edgeAgentPresetContent(
  runtime: EdgeApiRuntime,
  deployment: EdgeDeploymentProfile,
  availableModels: readonly { id: string; name: string }[],
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
    `  attachmentStorage: ${yamlString(deployment.attachmentStorage)}`,
    `  shell: ${yamlString(deployment.shell)}`,
    '  workspace: /workspace',
    'agent:',
    '  loop: "@deepseek-ai/dsh-agent-loop"',
    '  registry: "@deepseek-ai/dsh-agent"',
    '  sessionStore: "@deepseek-ai/dsh-session"',
    `  systemPrompt: ${yamlString(EDGE_SYSTEM_PROMPT)}`,
    'model:',
    `  provider: ${yamlString(EDGE_PROVIDER)}`,
    `  defaultId: ${yamlString(runtime.model)}`,
    '  selectionScope: session',
    '  catalogSource: upstream-provider',
    '  available:',
    ...availableModels.flatMap(model => [
      `    - id: ${yamlString(model.id)}`,
      `      name: ${yamlString(model.name)}`,
    ]),
    `  baseURL: ${yamlString(deployment.baseURL)}`,
    `  reasoningEffort: ${yamlString(deployment.reasoningEffort)}`,
    `  maxOutputTokens: ${String(deployment.maxTokens)}`,
    `  streamIdleTimeoutMs: ${String(deployment.streamIdleTimeoutMs)}`,
    '  credential:',
    '    ref: DEEPSEEK_API_KEY',
    `    configured: ${String(deployment.apiKeyConfigured)}`,
    `    persisted: ${String(deployment.apiKeyPersisted ?? false)}`,
    'attachments:',
    '  enabled: true',
    `  storage: ${yamlString(deployment.attachmentStorage)}`,
    ...deployment.attachmentStorage === 'temporary-do'
      ? [`  storageLimitBytes: ${String(EDGE_DO_ATTACHMENT_MAX_STORED_BYTES)}`]
      : [],
    `  mediaTypes: ${yamlString(runtime.imageLimits?.mediaTypes.join(',') ?? '')}`,
    `  maxImagesPerMessage: ${String(runtime.imageLimits?.maxImagesPerMessage ?? 0)}`,
    `  maxImageBytes: ${String(runtime.imageLimits?.maxImageBytes ?? 0)}`,
    `  maxMessageImageBytes: ${String(runtime.imageLimits?.maxMessageImageBytes ?? 0)}`,
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

function bytesToBase64(data: Uint8Array): string {
  const chunkSize = 32_768
  let binary = ''
  for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
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
    projections: summaryProjections(summary, runtime.imageLimits, runtime.sessions.projectionSnapshot(summary.id)?.values),
  }
}

function summaryProjections(
  summary: EdgeApiSessionSummary,
  imageLimits: ImageAttachmentLimits | undefined,
  registrySnapshot: Record<string, unknown> | undefined,
): SessionProjectionsBlock {
  return {
    asOfSeq: summary.lastSeq,
    values: {
      ...registrySnapshot,
      sessionListMetadata: {
        blank: summary.blank,
        lastPromptAt: summary.lastPromptAt,
      },
      ...summary.title === null ? {} : { title: summary.title },
      ...imageLimits === undefined ? {} : { imageLimits },
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
  if (error instanceof WorkspaceOrderInvalidError && workspaceId !== undefined) {
    return fail(request, {
      code: 'workspace-not-found',
      message: error.message,
      details: { workspaceId },
    })
  }
  if (error instanceof WorkspaceMoveInvalidError
    && workspaceId !== undefined && sessionId !== undefined) {
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
  if (error instanceof WorkspaceUnknownSessionError) {
    return fail(request, {
      code: 'session-not-found',
      message: error.message,
      details: { sessionId: error.sessionId },
    })
  }
  if (error instanceof Error && error.message.includes('path is not a directory')) {
    return fail(request, {
      code: 'workspace-invalid-path',
      message: error.message,
      details: { path: path ?? EDGE_WORKSPACE_PATH },
    })
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

function sanitizeProjectedURL(raw: string): string {
  try {
    const parsed = new URL(raw)
    const dirty = parsed.username.length > 0 || parsed.password.length > 0
      || parsed.search.length > 0 || parsed.hash.length > 0
    if (!dirty) return raw
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.href
  } catch {
    return raw
  }
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
  if (error instanceof EdgeSessionCwdConflictError && sessionId !== undefined) {
    return fail(request, {
      code: 'session-conflict',
      message: error.message,
      details: {
        sessionId,
        requestedCwd: error.requestedCwd,
        ...error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd },
      },
    })
  }
  if (error instanceof WorkspaceUnknownSessionError && sessionId !== undefined) {
    return fail(request, {
      code: 'session-not-found',
      message: error.message,
      details: { sessionId },
    })
  }
  return fail(request, {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  })
}

function descriptorToView(d: SettingsDescriptor): SettingsNamespaceView {
  return {
    ns: d.ns as string,
    schema: d.schema,
    value: d.value,
    revision: d.revision,
    applies: d.applies,
    secrets: (d.secrets ?? []).map(s => ({ path: s.path, set: s.set })),
    ...d.base === undefined ? {} : { base: d.base },
    ...d.user === undefined ? {} : { user: d.user },
  }
}

function settingsNotRegistered<T>(
  request: RpcRequest<{ ns: string }>,
  ns: string,
): RpcResponse<T> {
  return fail(request, {
    code: 'settings-rejected',
    message: `Settings namespace "${ns}" is not registered.`,
    details: { ns },
  })
}

function settingsWriteFailure<T>(
  request: RpcRequest<{ ns: string }>,
  error: unknown,
): RpcResponse<T> {
  const ns = request.payload.ns
  if (error instanceof SettingsConflictError) {
    return fail(request, {
      code: 'settings-conflict',
      message: error.message,
      details: { ns, expected: error.expected, actual: error.actual },
    })
  }
  return fail(request, {
    code: 'settings-rejected',
    message: error instanceof Error ? error.message : String(error),
    details: { ns },
  })
}

async function* emptyFrames<T>(): AsyncGenerator<T> {}

function isValidWorkspacePath(value: string): boolean {
  return (value === '/workspace' || value.startsWith('/workspace/'))
    && !value.includes('\0')
    && !value.split('/').includes('..')
}
