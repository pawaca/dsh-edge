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
 *   dsh-kv:{unitName}:__version__                       → number
 *   dsh-kv:{unitName}:__global__                        → value | StampedDocument
 *   dsh-kv:{unitName}:{table}:{key}                     → value | StampedDocument
 *   dsh-kv:{unitName}:__backup__:{table}:{key}:{stamp}  → BackupDocument
 *
 * Layout semantics follow the upstream `KvUnitDescriptor` contract:
 *
 * - `single` (the default): the unit stamp is exact. A stored stamp that
 *   differs from the descriptor version rejects the open with
 *   `version-mismatch`; values are stored bare.
 * - `per-record`: every document carries its own version stamp
 *   ({@link StampedDocument}); reads accept the descriptor version plus its
 *   `compatibleVersions`, and a document stamped with any other version is
 *   FOREIGN and reads as absent — never deleted, never a rejected open. Bare
 *   documents predate the stamped format; they inherit the unit stamp
 *   (`__version__`), which is therefore never rewritten once present, so a
 *   later version bump still classifies them by the version that wrote them.
 *   Writes always stamp the descriptor version, so a medium upgrades one
 *   record at a time as the owner rewrites it — no startup scan.
 */

const KV_PREFIX = 'dsh-kv:'
const DOCUMENT_KIND = 'dsh-kv-record'
const BACKUP_KIND = 'dsh-kv-backup'
const BACKUP_TABLE = '__backup__'
/** Per-record keys become key segments; the upstream contract rejects anything else on write. */
const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/

/** One `per-record` document: the version that wrote it plus the value. */
interface StampedDocument {
  readonly $kind: typeof DOCUMENT_KIND
  readonly version: number
  readonly record: unknown
}

/** A document moved aside by {@link KvUnit.backupRecord}, retained for inspection. */
interface BackupDocument {
  readonly $kind: typeof BACKUP_KIND
  readonly version: number | undefined
  readonly record: unknown
  readonly backedUpAt: string
}

function versionKey(unit: string): string {
  return `${KV_PREFIX}${unit}:__version__`
}

function globalKey(unit: string): string {
  return `${KV_PREFIX}${unit}:__global__`
}

function recordKey(unit: string, table: string, key: string): string {
  return `${KV_PREFIX}${unit}:${table}:${key}`
}

function backupKey(unit: string, table: string, key: string, stamp: string): string {
  return `${KV_PREFIX}${unit}:${BACKUP_TABLE}:${table}:${key}:${stamp}`
}

function unitPrefix(unit: string): string {
  return `${KV_PREFIX}${unit}:`
}

function isStampedDocument(value: unknown): value is StampedDocument {
  return typeof value === 'object'
    && value !== null
    && (value as { $kind?: unknown }).$kind === DOCUMENT_KIND
    && typeof (value as { version?: unknown }).version === 'number'
}

function stampDocument(version: number, record: unknown): StampedDocument {
  return { $kind: DOCUMENT_KIND, version, record }
}

/** UTC `YYYYMMDDHHmm` suffix for backed-up documents, matching the upstream json backend. */
function backupStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(now.getUTCFullYear())}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`
}

function assertSafeKey(unit: string, key: string): void {
  if (!SAFE_KEY_RE.test(key)) {
    throw new Error(`unit '${unit}': per-record key '${key}' is not key-safe (must match ${SAFE_KEY_RE})`)
  }
}

/**
 * One opened KV unit over Durable Object storage. Reads are list-scans;
 * writes are single-key puts; the domain layer serializes concurrent writes,
 * so no locking is needed here.
 */
class DurableObjectKvUnit implements KvUnit {
  private closed = false
  private readonly perRecord: boolean
  /** Version stamps this unit reads as its own (per-record layout only). */
  private readonly acceptedVersions: ReadonlySet<number>

  /**
   * Move one record's document out of the readable set. Only offered for the
   * `per-record` layout: a `single`-layout unit omits the member so the domain
   * layer takes its reject-loud path, per the upstream contract.
   */
  backupRecord?: (table: string, key: string) => Promise<string>

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly descriptor: KvUnitDescriptor,
    /** The stamp bare (pre-stamped-format) documents inherit. */
    private readonly legacyVersion: number,
  ) {
    this.perRecord = descriptor.layout === 'per-record'
    this.acceptedVersions = new Set([descriptor.version, ...descriptor.compatibleVersions ?? []])
    if (this.perRecord) {
      this.backupRecord = async (table, key) => {
        this.assertOpen()
        this.assertTable(table)
        const active = recordKey(this.descriptor.name, table, key)
        const stored = await this.storage.get(active)
        const moved = backupKey(this.descriptor.name, table, key, backupStamp(new Date()))
        if (stored !== undefined) {
          const backup: BackupDocument = {
            $kind: BACKUP_KIND,
            version: isStampedDocument(stored) ? stored.version : this.legacyVersion,
            record: isStampedDocument(stored) ? stored.record : stored,
            backedUpAt: new Date().toISOString(),
          }
          // Copy first, then delete: a crash between the two leaves the record
          // readable and re-backed-up on the next open, never lost.
          await this.storage.put(moved, backup)
          await this.storage.delete(active)
        }
        return moved
      }
    }
  }

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
        const read = this.readDocument(value)
        if (read.present) global = read.record
        continue
      }
      // Parse record keys: dsh-kv:{unit}:{table}:{recordKey}
      // The table name is the segment right after the unit prefix.
      const suffix = key.slice(prefix.length)
      const separatorIndex = suffix.indexOf(':')
      if (separatorIndex < 0) continue
      const tableName = suffix.slice(0, separatorIndex)
      const recordId = suffix.slice(separatorIndex + 1)
      // Skip meta keys and backed-up documents (never part of the readable set).
      if (tableName === '__version__' || tableName === '__global__' || tableName === BACKUP_TABLE) continue
      const table = tables[tableName]
      if (table === undefined) continue
      const read = this.readDocument(value)
      if (read.present) table[recordId] = read.record
    }
    return { tables, global }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    if (this.perRecord) assertSafeKey(this.descriptor.name, key)
    await this.storage.put(recordKey(this.descriptor.name, table, key), this.writeDocument(value))
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    await this.storage.delete(recordKey(this.descriptor.name, table, key))
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    await this.storage.put(globalKey(this.descriptor.name), this.writeDocument(value))
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /**
   * Classify one stored value. In the `single` layout every value is bare and
   * current. In the `per-record` layout a stamped document is readable only
   * when its stamp is accepted; a bare document inherits the unit stamp.
   */
  private readDocument(value: unknown): { present: true; record: unknown } | { present: false } {
    if (!this.perRecord) return { present: true, record: value }
    if (isStampedDocument(value)) {
      return this.acceptedVersions.has(value.version)
        ? { present: true, record: value.record }
        : { present: false }
    }
    return this.acceptedVersions.has(this.legacyVersion)
      ? { present: true, record: value }
      : { present: false }
  }

  private writeDocument(value: unknown): unknown {
    return this.perRecord ? stampDocument(this.descriptor.version, value) : value
  }

  private assertTable(table: string): void {
    if (!this.descriptor.tables.includes(table)) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
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

        const storedVersion = await this.storage.get(versionKey(descriptor.name))
        let legacyVersion = descriptor.version
        if (typeof storedVersion === 'number') {
          if (descriptor.layout === 'per-record') {
            // The stamp records which version wrote the bare documents; keep it
            // so a later bump still classifies them correctly, and never reject
            // the open — foreign documents simply read as absent.
            legacyVersion = storedVersion
          } else if (storedVersion !== descriptor.version) {
            throw new StorageError(
              'version-mismatch',
              `unit '${descriptor.name}' medium version ${JSON.stringify(storedVersion)} does not match descriptor version ${descriptor.version}`,
            )
          }
        } else if (storedVersion !== undefined) {
          throw new StorageError(
            'malformed-medium',
            `unit '${descriptor.name}' medium version ${JSON.stringify(storedVersion)} is not a number`,
          )
        } else {
          // First open: stamp the version
          await this.storage.put(versionKey(descriptor.name), descriptor.version)
        }

        this.openUnits.add(descriptor.name)
        const unit = new DurableObjectKvUnit(this.storage, descriptor, legacyVersion)
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
    if (oldState === undefined && oldRecords.size === 0) {
      return
    }

    const deleteKeys: string[] = []
    if (oldState !== undefined) {
      await storage.put(globalKey('workspace'), oldState)
      deleteKeys.push(stateKey)
    } else if (oldRecords.size > 0) {
      const recordIds = [...oldRecords.keys()].map(k => {
        const seg = k.slice(oldPrefix.length)
        return seg.endsWith(':v2') ? seg.slice(0, -3) : seg
      })
      await storage.put(globalKey('workspace'), {
        initialized: true,
        workspaceIds: recordIds,
        archivedSessionIds: [],
      })
    }
    await storage.put(versionKey('workspace'), 2)
    const epoch0 = new Date(0).toISOString()
    for (const [oldKey, value] of oldRecords) {
      const segment = oldKey.slice(oldPrefix.length)
      const id = segment.endsWith(':v2') ? segment.slice(0, -3) : segment
      const record = value as Record<string, unknown>
      repairEpoch0(record, epoch0)
      await storage.put(recordKey('workspace', 'workspaces', id), record)
      deleteKeys.push(oldKey)
    }
    if (deleteKeys.length > 0) await storage.delete(deleteKeys)
  }

  static async repairEpoch0Timestamps(storage: DurableObjectStorage): Promise<void> {
    const markerKey = 'dsh-edge:workspace-epoch0-repaired'
    if (await storage.get(markerKey) === true) return
    const epoch0 = new Date(0).toISOString()
    const prefix = recordKey('workspace', 'workspaces', '')
    const records = await storage.list({ prefix })
    for (const [key, value] of records) {
      const record = value as Record<string, unknown>
      if (record.createdAt !== epoch0 && record.updatedAt !== epoch0) continue
      repairEpoch0(record, epoch0)
      await storage.put(key, record)
    }
    await storage.put(markerKey, true)
  }
}

function repairEpoch0(record: Record<string, unknown>, epoch0: string): void {
  if (record.createdAt !== epoch0 && record.updatedAt !== epoch0) return
  if (record.updatedAt !== epoch0) {
    record.createdAt = record.updatedAt
  } else if (record.createdAt !== epoch0) {
    record.updatedAt = record.createdAt
  } else {
    const now = new Date().toISOString()
    record.createdAt = now
    record.updatedAt = now
  }
}
