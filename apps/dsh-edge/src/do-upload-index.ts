const STORAGE_KEY = 'dsh-edge:file-upload-index'
const MAX_INDEX_RECORDS = 256

interface UploadRecord {
  scope: string
  attachmentId: string
  variantId: string
  fileId: string
  bytes: number
  createdAt: number
  expiresAt: number
}

interface UploadIndex {
  formatVersion: 3
  records: UploadRecord[]
}

function reusable(record: UploadRecord, now: number, refreshMarginMs: number): boolean {
  return record.expiresAt - now > refreshMarginMs
}

export class DurableObjectUploadIndex {
  constructor(private readonly storage: DurableObjectStorage) {}

  private async load(): Promise<UploadIndex> {
    const raw = await this.storage.get(STORAGE_KEY) as UploadIndex | undefined
    if (raw === undefined || raw === null || typeof raw !== 'object' || !Array.isArray(raw.records)) {
      return { formatVersion: 3, records: [] }
    }
    return raw
  }

  private async save(index: UploadIndex): Promise<void> {
    await this.storage.put(STORAGE_KEY, index)
  }

  async get(
    scope: string,
    variantId: string,
    now: number,
    refreshMarginMs: number,
  ): Promise<UploadRecord | undefined> {
    const record = (await this.load()).records
      .find(r => r.scope === scope && r.variantId === variantId)
    return record !== undefined && reusable(record, now, refreshMarginMs) ? record : undefined
  }

  async commit(
    candidate: UploadRecord,
    now: number,
    refreshMarginMs: number,
  ): Promise<{ record: UploadRecord; accepted: boolean }> {
    const index = await this.load()
    const existing = index.records.find(r =>
      r.scope === candidate.scope
      && r.variantId === candidate.variantId
      && reusable(r, now, refreshMarginMs))
    if (existing !== undefined) return { record: existing, accepted: false }
    const records = index.records
      .filter(r => reusable(r, now, refreshMarginMs)
        && !(r.scope === candidate.scope && r.variantId === candidate.variantId))
    records.push(candidate)
    if (records.length > MAX_INDEX_RECORDS) {
      records.sort((a, b) => a.expiresAt - b.expiresAt)
      records.splice(0, records.length - MAX_INDEX_RECORDS)
    }
    await this.save({ formatVersion: 3, records })
    return { record: candidate, accepted: true }
  }

  async remove(scope: string, variantId: string, fileId: string): Promise<void> {
    const index = await this.load()
    const records = index.records
      .filter(r => !(r.scope === scope && r.variantId === variantId && r.fileId === fileId))
    if (records.length !== index.records.length) {
      await this.save({ formatVersion: 3, records })
    }
  }

  async clear(scope: string): Promise<void> {
    const index = await this.load()
    const records = index.records.filter(r => r.scope !== scope)
    if (records.length !== index.records.length) {
      await this.save({ formatVersion: 3, records })
    }
  }
}
