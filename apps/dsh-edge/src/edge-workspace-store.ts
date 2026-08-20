/** Cloudflare Durable Object adapter for the upstream workspace domain. */

import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { EdgeApiSessionSummary } from './session-store.ts'

export const EDGE_WORKSPACE_ID = 'edge-workspace' as WorkspaceId
export const EDGE_WORKSPACE_PATH = '/workspace'

const WORKSPACE_DOMAIN_STATE_KEY = 'dsh-edge:workspace-domain-state:v2'
const WORKSPACE_RECORD_KEY = 'dsh-edge:workspace-domain-workspaces:edge-workspace:v2'

/** Exact upstream workspace-domain global value, backed by DO storage. */
interface EdgeWorkspaceDomainState {
  initialized: boolean
  workspaceIds: WorkspaceId[]
  archivedSessionIds: SessionId[]
}

/** Exact upstream workspaces-table value, backed by DO storage. */
interface EdgeWorkspaceRecord {
  path: string
  title: string
  sessionIds: SessionId[]
  createdAt: string
  updatedAt: string
}

export class EdgeWorkspaceStoreError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_PATH' | 'MOVE_INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'EdgeWorkspaceStoreError'
  }
}

/**
 * Preserve the upstream workspace records/global-state split while replacing
 * its Node filesystem and storage-domain backends with one DO transaction.
 */
export class EdgeWorkspaceStore {
  private operationTail: Promise<void> = Promise.resolve()

  constructor(private readonly storage: DurableObjectStorage) {}

  list(sessions: readonly EdgeApiSessionSummary[]): Promise<{
    items: WorkspaceView[]
    archivedSessionIds: SessionId[]
  }> {
    return this.serialize(async () => {
      const state = await this.readState()
      if (!state.workspaceIds.includes(EDGE_WORKSPACE_ID)) {
        return { items: [], archivedSessionIds: state.archivedSessionIds }
      }
      const record = await this.readOrCreateRecord(sessions)
      return {
        items: [workspaceView(record)],
        archivedSessionIds: state.archivedSessionIds,
      }
    })
  }

  create(
    path: string,
    sessions: readonly EdgeApiSessionSummary[],
  ): Promise<{ workspace: WorkspaceView; created: boolean }> {
    return this.serialize(async () => {
      if (path !== EDGE_WORKSPACE_PATH) {
        throw new EdgeWorkspaceStoreError(
          'INVALID_PATH',
          `Edge workspaces must use ${EDGE_WORKSPACE_PATH}.`,
        )
      }
      const state = await this.readState()
      if (state.workspaceIds.includes(EDGE_WORKSPACE_ID)) {
        const record = await this.readOrCreateRecord(sessions)
        return { workspace: workspaceView(record), created: false }
      }
      const now = new Date().toISOString()
      const record: EdgeWorkspaceRecord = {
        path: EDGE_WORKSPACE_PATH,
        title: 'workspace',
        sessionIds: [],
        createdAt: now,
        updatedAt: now,
      }
      await this.storage.transaction(async (txn) => {
        await txn.put(WORKSPACE_RECORD_KEY, record)
        await txn.put(WORKSPACE_DOMAIN_STATE_KEY, {
          ...state,
          workspaceIds: [EDGE_WORKSPACE_ID],
        } satisfies EdgeWorkspaceDomainState)
      })
      return { workspace: workspaceView(record), created: true }
    })
  }

  rename(workspaceId: WorkspaceId, title: string, sessions: readonly EdgeApiSessionSummary[]): Promise<{
    workspace: WorkspaceView
    changed: boolean
  }> {
    return this.serialize(async () => {
      await this.requireWorkspace(workspaceId)
      const current = await this.readOrCreateRecord(sessions)
      if (current.title === title) return { workspace: workspaceView(current), changed: false }
      const next = { ...current, title, updatedAt: new Date().toISOString() }
      await this.storage.put(WORKSPACE_RECORD_KEY, next)
      return { workspace: workspaceView(next), changed: true }
    })
  }

  delete(workspaceId: WorkspaceId): Promise<void> {
    return this.serialize(async () => {
      const state = await this.requireWorkspace(workspaceId)
      await this.storage.transaction(async (txn) => {
        await txn.delete(WORKSPACE_RECORD_KEY)
        await txn.put(WORKSPACE_DOMAIN_STATE_KEY, {
          ...state,
          workspaceIds: [],
        } satisfies EdgeWorkspaceDomainState)
      })
    })
  }

  insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<WorkspaceId[]> {
    return this.serialize(async () => {
      const state = await this.requireWorkspace(workspaceId)
      if (beforeWorkspaceId !== undefined && beforeWorkspaceId !== EDGE_WORKSPACE_ID) {
        throw new EdgeWorkspaceStoreError(
          'NOT_FOUND',
          `Workspace "${beforeWorkspaceId}" is not available in this Edge instance.`,
        )
      }
      return [...state.workspaceIds]
    })
  }

  insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId: SessionId | undefined,
    sessions: readonly EdgeApiSessionSummary[],
  ): Promise<{ workspace: WorkspaceView; changed: boolean }> {
    return this.serialize(async () => {
      await this.requireWorkspace(workspaceId)
      const current = await this.readOrCreateRecord(sessions)
      if (!current.sessionIds.includes(sessionId)) {
        throw new EdgeWorkspaceStoreError(
          'MOVE_INVALID',
          `Session "${sessionId}" is not accounted by workspace "${workspaceId}".`,
        )
      }
      if (beforeSessionId !== undefined && !current.sessionIds.includes(beforeSessionId)) {
        throw new EdgeWorkspaceStoreError(
          'MOVE_INVALID',
          `Anchor session "${beforeSessionId}" is not accounted by workspace "${workspaceId}".`,
        )
      }
      if (beforeSessionId === sessionId) {
        return { workspace: workspaceView(current), changed: false }
      }
      const without = current.sessionIds.filter(id => id !== sessionId)
      const index = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId)
      const sessionIds = [...without.slice(0, index), sessionId, ...without.slice(index)]
      if (sameIds(sessionIds, current.sessionIds)) {
        return { workspace: workspaceView(current), changed: false }
      }
      const next = { ...current, sessionIds, updatedAt: new Date().toISOString() }
      await this.storage.put(WORKSPACE_RECORD_KEY, next)
      return { workspace: workspaceView(next), changed: true }
    })
  }

  attachSession(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    sessions: readonly EdgeApiSessionSummary[],
  ): Promise<WorkspaceView> {
    return this.serialize(async () => {
      await this.requireWorkspace(workspaceId)
      const current = await this.readOrCreateRecord(sessions)
      if (current.sessionIds.includes(sessionId)) return workspaceView(current)
      const next = {
        ...current,
        sessionIds: [sessionId, ...current.sessionIds],
        updatedAt: new Date().toISOString(),
      }
      await this.storage.put(WORKSPACE_RECORD_KEY, next)
      return workspaceView(next)
    })
  }

  workspaceForSession(
    sessionId: SessionId,
    sessions: readonly EdgeApiSessionSummary[],
  ): Promise<WorkspaceId | undefined> {
    return this.serialize(async () => {
      const state = await this.readState()
      if (!state.workspaceIds.includes(EDGE_WORKSPACE_ID)) return undefined
      const current = await this.readOrCreateRecord(sessions)
      return current.sessionIds.includes(sessionId) ? EDGE_WORKSPACE_ID : undefined
    })
  }

  archivedSessionIds(): Promise<SessionId[]> {
    return this.serialize(async () => [...(await this.readState()).archivedSessionIds])
  }

  archiveSession(sessionId: SessionId, requireSession: () => Promise<unknown>): Promise<{
    archivedSessionIds: SessionId[]
    changed: boolean
  }> {
    return this.serialize(async () => {
      const state = await this.readState()
      if (state.archivedSessionIds.includes(sessionId)) {
        return { archivedSessionIds: [...state.archivedSessionIds], changed: false }
      }
      await requireSession()
      const archivedSessionIds = [...state.archivedSessionIds, sessionId]
      await this.storage.put(WORKSPACE_DOMAIN_STATE_KEY, {
        ...state,
        archivedSessionIds,
      } satisfies EdgeWorkspaceDomainState)
      return { archivedSessionIds, changed: true }
    })
  }

  private async requireWorkspace(workspaceId: WorkspaceId): Promise<EdgeWorkspaceDomainState> {
    const state = await this.readState()
    if (workspaceId !== EDGE_WORKSPACE_ID || !state.workspaceIds.includes(workspaceId)) {
      throw new EdgeWorkspaceStoreError(
        'NOT_FOUND',
        `Workspace "${workspaceId}" is not available in this Edge instance.`,
      )
    }
    return state
  }

  private async readOrCreateRecord(
    sessions: readonly EdgeApiSessionSummary[],
  ): Promise<EdgeWorkspaceRecord> {
    const stored = await this.storage.get(WORKSPACE_RECORD_KEY)
    if (stored !== undefined) return workspaceRecordFromStorage(stored)
    const record = defaultWorkspaceRecord(sessions)
    await this.storage.put(WORKSPACE_RECORD_KEY, record)
    return record
  }

  private async readState(): Promise<EdgeWorkspaceDomainState> {
    const stored = await this.storage.get(WORKSPACE_DOMAIN_STATE_KEY)
    if (stored === undefined) {
      return {
        initialized: true,
        workspaceIds: [EDGE_WORKSPACE_ID],
        archivedSessionIds: [],
      }
    }
    return workspaceDomainStateFromStorage(stored)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function defaultWorkspaceRecord(sessions: readonly EdgeApiSessionSummary[]): EdgeWorkspaceRecord {
  const createdAt = sessions.length === 0
    ? new Date(0).toISOString()
    : new Date(Math.min(...sessions.map(session => session.createdAt))).toISOString()
  const updatedAt = sessions.length === 0
    ? createdAt
    : new Date(Math.max(...sessions.map(session => session.updatedAt))).toISOString()
  return {
    path: EDGE_WORKSPACE_PATH,
    title: 'Workspace',
    sessionIds: sessions.map(session => session.id),
    createdAt,
    updatedAt,
  }
}

function workspaceView(record: EdgeWorkspaceRecord): WorkspaceView {
  return { workspaceId: EDGE_WORKSPACE_ID, ...record, sessionIds: [...record.sessionIds] }
}

function sameIds(left: readonly SessionId[], right: readonly SessionId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function workspaceDomainStateFromStorage(stored: unknown): EdgeWorkspaceDomainState {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    throw new Error('dsh-edge workspace domain state is invalid.')
  }
  const value = stored as Record<string, unknown>
  const workspaceIds = value.workspaceIds
  const archivedSessionIds = value.archivedSessionIds
  if (value.initialized !== true
    || !Array.isArray(workspaceIds)
    || workspaceIds.some(id => id !== EDGE_WORKSPACE_ID)
    || new Set(workspaceIds).size !== workspaceIds.length
    || !Array.isArray(archivedSessionIds)
    || archivedSessionIds.some(id => typeof id !== 'string' || id.length === 0)
    || new Set(archivedSessionIds).size !== archivedSessionIds.length
    || Object.hasOwn(value, 'pendingMutation')) {
    throw new Error('dsh-edge workspace domain state is invalid.')
  }
  return {
    initialized: true,
    workspaceIds: workspaceIds.map(() => EDGE_WORKSPACE_ID),
    archivedSessionIds: archivedSessionIds as SessionId[],
  }
}

function workspaceRecordFromStorage(stored: unknown): EdgeWorkspaceRecord {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    throw new Error('dsh-edge workspace record is invalid.')
  }
  const value = stored as Record<string, unknown>
  if (value.path !== EDGE_WORKSPACE_PATH
    || typeof value.title !== 'string'
    || !Array.isArray(value.sessionIds)
    || value.sessionIds.some(id => typeof id !== 'string' || id.length === 0)
    || new Set(value.sessionIds).size !== value.sessionIds.length
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string') {
    throw new Error('dsh-edge workspace record is invalid.')
  }
  return {
    path: EDGE_WORKSPACE_PATH,
    title: value.title,
    sessionIds: value.sessionIds as SessionId[],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}
