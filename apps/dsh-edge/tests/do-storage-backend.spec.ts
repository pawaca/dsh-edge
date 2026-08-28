import { describe, expect, it } from 'vitest'
import { DurableObjectStorageBackend } from '../src/do-storage-backend.ts'

const EPOCH_0 = new Date(0).toISOString()
const REAL_TS = '2026-05-01T12:00:00.000Z'

function createMockStorage(): DurableObjectStorage & { readonly store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get: (key: string) => Promise.resolve(store.get(key)),
    put: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve() },
    delete: (keys: string | string[]) => {
      const arr = Array.isArray(keys) ? keys : [keys]
      for (const k of arr) store.delete(k)
      return Promise.resolve(arr.length)
    },
    list: (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? ''
      const result = new Map<string, unknown>()
      for (const [k, v] of store) {
        if (k.startsWith(prefix)) result.set(k, v)
      }
      return Promise.resolve(result)
    },
  } as unknown as DurableObjectStorage & { readonly store: Map<string, unknown> }
}

describe('repairEpoch0Timestamps', () => {
  it('replaces both epoch-0 timestamps with now', async () => {
    const storage = createMockStorage()
    storage.store.set('dsh-kv:workspace:workspaces:ws-1', {
      path: '/workspace',
      title: 'workspace',
      sessionIds: [],
      createdAt: EPOCH_0,
      updatedAt: EPOCH_0,
    })
    await DurableObjectStorageBackend.repairEpoch0Timestamps(storage)
    const record = storage.store.get('dsh-kv:workspace:workspaces:ws-1') as Record<string, unknown>
    expect(record.createdAt).not.toBe(EPOCH_0)
    expect(record.updatedAt).not.toBe(EPOCH_0)
    expect(record.createdAt).toBe(record.updatedAt)
  })

  it('derives createdAt from updatedAt when only createdAt is epoch-0', async () => {
    const storage = createMockStorage()
    storage.store.set('dsh-kv:workspace:workspaces:ws-2', {
      path: '/workspace',
      title: 'workspace',
      sessionIds: ['s-1'],
      createdAt: EPOCH_0,
      updatedAt: REAL_TS,
    })
    await DurableObjectStorageBackend.repairEpoch0Timestamps(storage)
    const record = storage.store.get('dsh-kv:workspace:workspaces:ws-2') as Record<string, unknown>
    expect(record.createdAt).toBe(REAL_TS)
    expect(record.updatedAt).toBe(REAL_TS)
  })

  it('derives updatedAt from createdAt when only updatedAt is epoch-0', async () => {
    const storage = createMockStorage()
    storage.store.set('dsh-kv:workspace:workspaces:ws-3', {
      path: '/workspace',
      title: 'workspace',
      sessionIds: [],
      createdAt: REAL_TS,
      updatedAt: EPOCH_0,
    })
    await DurableObjectStorageBackend.repairEpoch0Timestamps(storage)
    const record = storage.store.get('dsh-kv:workspace:workspaces:ws-3') as Record<string, unknown>
    expect(record.createdAt).toBe(REAL_TS)
    expect(record.updatedAt).toBe(REAL_TS)
  })

  it('skips records with valid timestamps', async () => {
    const storage = createMockStorage()
    storage.store.set('dsh-kv:workspace:workspaces:ws-ok', {
      path: '/workspace',
      title: 'workspace',
      sessionIds: [],
      createdAt: REAL_TS,
      updatedAt: REAL_TS,
    })
    await DurableObjectStorageBackend.repairEpoch0Timestamps(storage)
    const record = storage.store.get('dsh-kv:workspace:workspaces:ws-ok') as Record<string, unknown>
    expect(record.createdAt).toBe(REAL_TS)
    expect(record.updatedAt).toBe(REAL_TS)
  })

  it('sets a marker and skips subsequent activations', async () => {
    const storage = createMockStorage()
    storage.store.set('dsh-kv:workspace:workspaces:ws-m', {
      path: '/workspace',
      title: 'workspace',
      sessionIds: [],
      createdAt: EPOCH_0,
      updatedAt: EPOCH_0,
    })
    await DurableObjectStorageBackend.repairEpoch0Timestamps(storage)
    expect(storage.store.get('dsh-edge:workspace-epoch0-repaired')).toBe(true)
    const record = storage.store.get('dsh-kv:workspace:workspaces:ws-m') as Record<string, unknown>
    expect(record.createdAt).not.toBe(EPOCH_0)

    // Second call with marker set — should not scan records
    record.createdAt = EPOCH_0
    await DurableObjectStorageBackend.repairEpoch0Timestamps(storage)
    expect(record.createdAt).toBe(EPOCH_0)
  })
})

describe('migrateWorkspaceKeys', () => {
  it('repairs epoch-0 timestamps during migration', async () => {
    const storage = createMockStorage()
    storage.store.set('dsh-edge:workspace-domain-state:v2', {
      initialized: true,
      workspaceIds: ['edge-workspace'],
    })
    storage.store.set('dsh-edge:workspace-domain-workspaces:edge-workspace:v2', {
      path: '/workspace',
      title: 'Workspace',
      sessionIds: [],
      createdAt: EPOCH_0,
      updatedAt: REAL_TS,
    })
    await DurableObjectStorageBackend.migrateWorkspaceKeys(storage)
    const record = storage.store.get('dsh-kv:workspace:workspaces:edge-workspace') as Record<string, unknown>
    expect(record.createdAt).toBe(REAL_TS)
    expect(record.updatedAt).toBe(REAL_TS)
    expect(storage.store.has('dsh-edge:workspace-domain-state:v2')).toBe(false)
    expect(storage.store.has('dsh-edge:workspace-domain-workspaces:edge-workspace:v2')).toBe(false)
  })
})
