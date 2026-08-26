/** Cloudflare Durable Object KV backend for the upstream storage hub. */

import type {
  StorageBackend,
  KvFacet,
  KvUnit,
  KvUnitDescriptor,
} from '@deepseek-ai/dsh-storage'
import { StorageError } from '@deepseek-ai/dsh-storage'

/**
 * Key schema (all prefixed to avoid collisions with other DO KV usage):
 *
 *   dsh-kv:{unitName}:__version__           → number
 *   dsh-kv:{unitName}:__global__            → unknown (JSON value)
 *   dsh-kv:{unitName}:{table}:{key}         → unknown (JSON value)
 */

const KV_PREFIX = 'dsh-kv:'

function versionKey(unit: string): string {
  return `${KV_PREFIX}${unit}:__version__`
}

function globalKey(unit: string): string {
  return `${KV_PREFIX}${unit}:__global__`
}

function recordKey(unit: string, table: string, key: string): string {
  return `${KV_PREFIX}${unit}:${table}:${key}`
}

function unitPrefix(unit: string): string {
  return `${KV_PREFIX}${unit}:`
}


/**
 * One opened KV unit over Durable Object storage. Reads are list-scans;
 * writes are single-key puts; the domain layer serializes concurrent writes,
 * so no locking is needed here.
 */
class DurableObjectKvUnit implements KvUnit {
  private closed = false

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly descriptor: KvUnitDescriptor,
  ) {}

  async loadAll(): Promise<{
    tables: Record<string, Record<string, unknown>>
    global: unknown
  }> {
    this.assertOpen()
    const prefix = unitPrefix(this.descriptor.name)
    const entries = await this.storage.list({ prefix })
    const tables: Record<string, Record<string, unknown>> = {}
    for (const table of this.descriptor.tables) {
      tables[table] = {}
    }
    let global: unknown = null
    const gk = globalKey(this.descriptor.name)
    for (const [key, value] of entries) {
      if (key === versionKey(this.descriptor.name)) continue
      if (key === gk) {
        global = value
        continue
      }
      // Parse record keys: dsh-kv:{unit}:{table}:{recordKey}
      // The table name is the segment right after the unit prefix.
      const suffix = key.slice(prefix.length)
      const separatorIndex = suffix.indexOf(':')
      if (separatorIndex < 0) continue
      const tableName = suffix.slice(0, separatorIndex)
      const recordId = suffix.slice(separatorIndex + 1)
      // Skip meta keys
      if (tableName === '__version__' || tableName === '__global__') continue
      if (tables[tableName] !== undefined) {
        tables[tableName]![recordId] = value
      }
    }
    return { tables, global }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    await this.storage.put(recordKey(this.descriptor.name, table, key), value)
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    await this.storage.delete(recordKey(this.descriptor.name, table, key))
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    await this.storage.put(globalKey(this.descriptor.name), value)
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
    }
  }
}

/**
 * Maps the upstream {@link StorageBackend} interface to Cloudflare
 * Durable Object `ctx.storage`. Each domain is a KV unit; all keys
 * are prefixed with `dsh-kv:` to coexist with the existing DO schema.
 */
export class DurableObjectStorageBackend implements StorageBackend {
  private readonly openUnits = new Set<string>()

  readonly kv: KvFacet

  constructor(private readonly storage: DurableObjectStorage) {
    this.kv = {
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        if (this.openUnits.has(descriptor.name)) {
          throw new Error(`unit '${descriptor.name}' is already open`)
        }

        // Check version stamp on the medium
        const storedVersion = await this.storage.get(
          versionKey(descriptor.name),
        )
        if (storedVersion !== undefined) {
          if (storedVersion !== descriptor.version) {
            throw new StorageError(
              'version-mismatch',
              `unit '${descriptor.name}' medium version ${JSON.stringify(storedVersion)} does not match descriptor version ${descriptor.version}`,
            )
          }
        } else {
          // First open: stamp the version
          await this.storage.put(
            versionKey(descriptor.name),
            descriptor.version,
          )
        }

        this.openUnits.add(descriptor.name)
        const unit = new DurableObjectKvUnit(this.storage, descriptor)
        const originalClose = unit.close.bind(unit)
        unit.close = async () => {
          this.openUnits.delete(descriptor.name)
          await originalClose()
        }
        return unit
      },
    }
  }

  async close(): Promise<void> {
    this.openUnits.clear()
  }

  static async migrateWorkspaceKeys(storage: DurableObjectStorage): Promise<void> {
    const stateKey = 'dsh-edge:workspace-domain-state:v2'
    const oldPrefix = 'dsh-edge:workspace-domain-workspaces:'
    const oldState = await storage.get<Record<string, unknown>>(stateKey)
    const oldRecords = await storage.list({ prefix: oldPrefix })
    if (oldState === undefined && oldRecords.size === 0) return

    const deleteKeys: string[] = []
    if (oldState !== undefined) {
      await storage.put(globalKey('workspaces'), oldState)
      deleteKeys.push(stateKey)
    }
    await storage.put(versionKey('workspaces'), 2)
    for (const [oldKey, value] of oldRecords) {
      const segment = oldKey.slice(oldPrefix.length)
      const id = segment.endsWith(':v2') ? segment.slice(0, -3) : segment
      await storage.put(recordKey('workspaces', 'workspaces', id), value)
      deleteKeys.push(oldKey)
    }
    if (deleteKeys.length > 0) await storage.delete(deleteKeys)
  }
}
