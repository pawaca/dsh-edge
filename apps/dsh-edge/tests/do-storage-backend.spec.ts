import { SessionId } from '@deepseek-ai/dsh-session'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
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

const PER_RECORD_V5: KvUnitDescriptor = {
  name: 'projcache',
  version: 5,
  tables: ['sessions'],
  hasGlobal: false,
  layout: 'per-record',
  compatibleVersions: [3, 4],
}
const SINGLE_V5: KvUnitDescriptor = {
  name: 'projcache',
  version: 5,
  tables: ['sessions'],
  hasGlobal: false,
}
const STAMP = 'dsh-kv:projcache:__version__'
const REC = (id: string): string => `dsh-kv:projcache:sessions:${id}`
const V3_RECORD = { identity: { createdAt: 1000, cwd: '/workspace' }, rows: {} }

describe('DurableObjectStorageBackend kv unit contract', () => {
  it('reads a v3 per-record medium under a v5 descriptor that lists 3 as compatible', async () => {
    const storage = createMockStorage()
    storage.store.set(STAMP, 3)
    storage.store.set(REC('s-1'), V3_RECORD)
    const unit = await new DurableObjectStorageBackend(storage).kv.open(PER_RECORD_V5)
    const snapshot = await unit.loadAll()
    expect(snapshot.tables.sessions).toEqual({ 's-1': V3_RECORD })
    // The unit stamp still records which version wrote the bare documents.
    expect(storage.store.get(STAMP)).toBe(3)
  })

  it('keeps single-layout units exact-version: a v3 medium rejects a v5 descriptor', async () => {
    const storage = createMockStorage()
    storage.store.set(STAMP, 3)
    storage.store.set(REC('s-1'), V3_RECORD)
    await expect(new DurableObjectStorageBackend(storage).kv.open(SINGLE_V5))
      .rejects.toMatchObject({ code: 'version-mismatch' })
  })

  it('reads per-record documents outside the accepted set as absent without deleting them', async () => {
    const storage = createMockStorage()
    storage.store.set(STAMP, 2)
    storage.store.set(REC('stale'), V3_RECORD)
    const unit = await new DurableObjectStorageBackend(storage).kv.open(PER_RECORD_V5)
    expect((await unit.loadAll()).tables.sessions).toEqual({})
    expect(storage.store.get(REC('stale'))).toEqual(V3_RECORD)
    expect(storage.store.get(STAMP)).toBe(2)
  })

  it('stamps rewritten records with the current version so mixed media read per document', async () => {
    const storage = createMockStorage()
    storage.store.set(STAMP, 3)
    storage.store.set(REC('old'), V3_RECORD)
    storage.store.set(REC('rewritten'), V3_RECORD)
    const backend = new DurableObjectStorageBackend(storage)
    const unit = await backend.kv.open(PER_RECORD_V5)
    const current = { identity: { createdAt: 2000, cwd: '/workspace', isSeeded: false }, rows: {} }
    await unit.putRecord('sessions', 'rewritten', current)
    await unit.close()
    expect(storage.store.get(REC('rewritten'))).toMatchObject({ version: 5, record: current })

    const reopened = await backend.kv.open(PER_RECORD_V5)
    expect((await reopened.loadAll()).tables.sessions).toEqual({ old: V3_RECORD, rewritten: current })
    await reopened.close()

    // A later bump that drops 3 from the accepted set keeps only the v5 document.
    const v6 = { ...PER_RECORD_V5, version: 6, compatibleVersions: [5] }
    const bumped = await backend.kv.open(v6)
    expect((await bumped.loadAll()).tables.sessions).toEqual({ rewritten: current })
    expect(storage.store.get(REC('old'))).toEqual(V3_RECORD)
  })

  it('moves a record aside on backupRecord and lets a later put recreate it', async () => {
    const storage = createMockStorage()
    storage.store.set(STAMP, 3)
    storage.store.set(REC('broken'), { identity: 'not-an-object' })
    storage.store.set(REC('healthy'), V3_RECORD)
    const unit = await new DurableObjectStorageBackend(storage).kv.open(PER_RECORD_V5)
    expect(typeof unit.backupRecord).toBe('function')
    const moved = await unit.backupRecord!('sessions', 'broken')
    expect(moved).toMatch(/^dsh-kv:projcache:__backup__:sessions:broken:\d{12}$/u)
    expect(storage.store.get(REC('broken'))).toBeUndefined()
    expect(storage.store.get(moved)).toMatchObject({
      $kind: 'dsh-kv-backup',
      version: 3,
      record: { identity: 'not-an-object' },
    })
    expect((await unit.loadAll()).tables.sessions).toEqual({ healthy: V3_RECORD })
    await unit.putRecord('sessions', 'broken', V3_RECORD)
    expect((await unit.loadAll()).tables.sessions).toEqual({ healthy: V3_RECORD, broken: V3_RECORD })
    // The backup document never re-enters the readable set.
    expect(storage.store.has(moved)).toBe(true)
  })

  it('omits backupRecord for single-layout units so the domain layer rejects loudly', async () => {
    const storage = createMockStorage()
    const unit = await new DurableObjectStorageBackend(storage).kv.open(SINGLE_V5)
    expect(typeof unit.backupRecord).toBe('undefined')
    await unit.putRecord('sessions', 'opaque:key/with slashes', V3_RECORD)
    expect(storage.store.get(REC('opaque:key/with slashes'))).toEqual(V3_RECORD)
  })

  it('rejects key-unsafe per-record writes but still reads and deletes legacy keys', async () => {
    const storage = createMockStorage()
    storage.store.set(STAMP, 3)
    storage.store.set(REC('legacy:key'), V3_RECORD)
    const unit = await new DurableObjectStorageBackend(storage).kv.open(PER_RECORD_V5)
    await expect(unit.putRecord('sessions', 'bad/key', V3_RECORD)).rejects.toThrow(/not key-safe/u)
    expect((await unit.loadAll()).tables.sessions).toEqual({ 'legacy:key': V3_RECORD })
    await unit.deleteRecord('sessions', 'legacy:key')
    expect((await unit.loadAll()).tables.sessions).toEqual({})
  })

  it('stamps the global slot in the per-record layout and reads a bare legacy global', async () => {
    const storage = createMockStorage()
    storage.store.set(STAMP, 3)
    storage.store.set('dsh-kv:projcache:__global__', { cursor: 1 })
    const descriptor = { ...PER_RECORD_V5, hasGlobal: true }
    const unit = await new DurableObjectStorageBackend(storage).kv.open(descriptor)
    expect((await unit.loadAll()).global).toEqual({ cursor: 1 })
    await unit.setGlobal({ cursor: 2 })
    expect(storage.store.get('dsh-kv:projcache:__global__')).toMatchObject({ version: 5, record: { cursor: 2 } })
    expect((await unit.loadAll()).global).toEqual({ cursor: 2 })
  })

  it('rejects a non-numeric unit stamp as a malformed medium', async () => {
    const storage = createMockStorage()
    storage.store.set(STAMP, 'three')
    await expect(new DurableObjectStorageBackend(storage).kv.open(PER_RECORD_V5))
      .rejects.toMatchObject({ code: 'malformed-medium' })
  })
})

describe('session_projcache over the Durable Object backend', () => {
  async function openProjectionCache(storage: DurableObjectStorage) {
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: Storage } = await import('@deepseek-ai/dsh-storage')
    const StorageDomain = await import('@deepseek-ai/dsh-storage-domain')
    const { projectionCacheDomainSpec } = await import('@deepseek-ai/dsh-session-projection-cache')
    const ctx = new Context()
    const errors: string[] = []
    ctx.logger.error = (message: unknown) => { errors.push(String(message)) }
    await ctx.plugin(Storage)
    ctx.effect(() => {
      const dispose = ctx.storage.backend.register('durable-object', new DurableObjectStorageBackend(storage))
      ctx.provide('storage.backend.durable-object', true)
      return () => { dispose() }
    }, 'test: storage backend')
    await ctx.plugin(StorageDomain, { backend: 'durable-object' })
    const domain = await ctx.storageDomain.open(projectionCacheDomainSpec)
    return { domain, errors, spec: projectionCacheDomainSpec }
  }

  it('boots a Harness 0.1.1-rc.2 (v3) cache medium and serves its records', async () => {
    const storage = createMockStorage()
    storage.store.set('dsh-kv:session_projcache:__version__', 3)
    storage.store.set('dsh-kv:session_projcache:sessions:session-old', V3_RECORD)
    const { domain, errors, spec } = await openProjectionCache(storage)
    expect(spec.version).toBe(5)
    expect(spec.compatibleVersions).toEqual([3, 4])
    expect(domain.table('sessions').get(SessionId('session-old'))).toMatchObject({ identity: { createdAt: 1000 } })
    expect(errors).toEqual([])
    await domain.close()
  })

  it('backs up and skips a schema-invalid cache record instead of failing the boot', async () => {
    const storage = createMockStorage()
    storage.store.set('dsh-kv:session_projcache:__version__', 3)
    storage.store.set('dsh-kv:session_projcache:sessions:good', V3_RECORD)
    storage.store.set('dsh-kv:session_projcache:sessions:corrupt', { identity: { createdAt: 'yesterday' }, rows: {} })
    const { domain, errors } = await openProjectionCache(storage)
    expect(domain.table('sessions').get(SessionId('good'))).toBeDefined()
    expect(domain.table('sessions').get(SessionId('corrupt'))).toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/corrupt.*moved to 'dsh-kv:session_projcache:__backup__:sessions:corrupt:\d{12}'/u)
    expect(storage.store.get('dsh-kv:session_projcache:sessions:corrupt')).toBeUndefined()
    expect([...storage.store.keys()].some(key => key.startsWith('dsh-kv:session_projcache:__backup__:sessions:corrupt:'))).toBe(true)
    await domain.close()
  })
})
