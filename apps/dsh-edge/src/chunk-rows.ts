/**
 * Lossless row packing for assistant/chunk delta runs, adapted from the
 * upstream dsh-session chunk-rows module (removed from the public API in
 * 0.1.5). Edge's DO SQL storage uses this codec to compress consecutive
 * streaming chunks into single rows and expand them back.
 *
 * Removal condition: when upstream re-exports the codec or Edge moves to a
 * different SQL storage encoding.
 */

import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'

type DeltaKind = 'text-delta' | 'reasoning-delta' | 'tool-call-delta'
interface DeltaEvent {
  type: 'assistant/chunk'
  seq: SessionSeqType
  time: number
  data: { turn: number; step: number; chunk: StreamChunk }
}

interface RunDataBase {
  turn: number
  step: number
  index: number
  dt: number[]
}
interface TextRunData extends RunDataBase { texts: string[] }
interface ToolCallRunData extends RunDataBase { id: ToolCallId; name?: string; args: string[] }

type ChunkRow =
  | { type: 'text-chunks'; seq0: SessionSeqType; time0: number; data: TextRunData }
  | { type: 'reasoning-chunks'; seq0: SessionSeqType; time0: number; data: TextRunData }
  | { type: 'tool-call-chunks'; seq0: SessionSeqType; time0: number; data: ToolCallRunData }

type StorageRecord = SessionEvent | DeltaEvent | ChunkRow

const MIN_RUN = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k))
}

function classify(event: SessionEvent | DeltaEvent): DeltaKind | undefined {
  if (event.type !== 'assistant/chunk') return undefined
  if (!hasExactKeys(event as object, ['type', 'seq', 'time', 'data'])) return undefined
  if (!Number.isSafeInteger(event.seq) || event.seq < 0 || Object.is(event.seq, -0)
    || !Number.isSafeInteger(event.time)) return undefined
  const data: unknown = event.data
  if (!isRecord(data) || !hasExactKeys(data, ['turn', 'step', 'chunk'])) return undefined
  if (typeof data.turn !== 'number' || typeof data.step !== 'number') return undefined
  const chunk = data.chunk
  if (!isRecord(chunk) || typeof chunk.index !== 'number') return undefined
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return hasExactKeys(chunk, ['type', 'index', 'text']) && typeof chunk.text === 'string'
        ? chunk.type
        : undefined
    case 'tool-call-delta': {
      const shapeOk = hasExactKeys(chunk, ['type', 'index', 'id', 'argumentsDelta'])
        || (hasExactKeys(chunk, ['type', 'index', 'id', 'name', 'argumentsDelta']) && typeof chunk.name === 'string')
      return shapeOk && typeof chunk.id === 'string' && typeof chunk.argumentsDelta === 'string'
        ? chunk.type
        : undefined
    }
    default:
      return undefined
  }
}

function toolCallOf(event: DeltaEvent): { id: string; name?: string } {
  return event.data.chunk as { id: string; name?: string }
}

function indexOf(event: DeltaEvent): number {
  return (event.data.chunk as { index: number }).index
}

function continues(prev: DeltaEvent, next: DeltaEvent, kind: DeltaKind): boolean {
  if (next.seq !== prev.seq + 1) return false
  if (!Number.isSafeInteger(next.time - prev.time)) return false
  if (next.data.turn !== prev.data.turn || next.data.step !== prev.data.step) return false
  if (indexOf(next) !== indexOf(prev)) return false
  if (kind !== 'tool-call-delta') return true
  const a = toolCallOf(prev)
  const b = toolCallOf(next)
  return a.id === b.id && Object.hasOwn(a, 'name') === Object.hasOwn(b, 'name') && a.name === b.name
}

function buildRow(kind: DeltaKind, run: readonly DeltaEvent[]): ChunkRow {
  const first = run[0] as DeltaEvent
  const base = {
    turn: first.data.turn,
    step: first.data.step,
    index: indexOf(first),
    dt: run.slice(1).map((event, i) => event.time - (run[i] as DeltaEvent).time),
  }
  const envelope = { seq0: first.seq, time0: first.time }
  if (kind === 'tool-call-delta') {
    const call = toolCallOf(first)
    return {
      type: 'tool-call-chunks',
      ...envelope,
      data: {
        ...base,
        id: brandString<ToolCallId>(call.id),
        ...Object.hasOwn(call, 'name') ? { name: call.name as string } : {},
        args: run.map(event => (event.data.chunk as { argumentsDelta: string }).argumentsDelta),
      },
    }
  }
  const data = { ...base, texts: run.map(event => (event.data.chunk as { text: string }).text) }
  return kind === 'text-delta'
    ? { type: 'text-chunks', ...envelope, data }
    : { type: 'reasoning-chunks', ...envelope, data }
}

export function packChunkRuns(events: readonly SessionEvent[]): Record<string, unknown>[] {
  const out: StorageRecord[] = []
  let kind: DeltaKind | undefined
  let run: DeltaEvent[] = []
  const flush = (): void => {
    if (kind !== undefined && run.length >= MIN_RUN) out.push(buildRow(kind, run))
    else out.push(...run as unknown as SessionEvent[])
    kind = undefined
    run = []
  }
  for (const event of events) {
    const k = classify(event as SessionEvent | DeltaEvent)
    if (k === undefined) {
      flush()
      out.push(event)
      continue
    }
    const delta = event as unknown as DeltaEvent
    const last = run[run.length - 1]
    if (k === kind && last !== undefined && continues(last, delta, k)) {
      run.push(delta)
      continue
    }
    flush()
    kind = k
    run = [delta]
  }
  flush()
  return out as Record<string, unknown>[]
}

function malformed(tag: string, why: string): never {
  throw new Error(`malformed ${tag} storage row: ${why}`)
}

function validateRunData(tag: string, data: Record<string, unknown>, payloadKey: 'texts' | 'args'): string[] {
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') {
    malformed(tag, 'turn/step/index must be numbers')
  }
  const payload = data[payloadKey]
  if (!Array.isArray(payload) || payload.length === 0 || payload.some(entry => typeof entry !== 'string')) {
    malformed(tag, `${payloadKey} must be a non-empty string array`)
  }
  const dt = data.dt
  if (!Array.isArray(dt) || dt.some(gap => !Number.isSafeInteger(gap))) {
    malformed(tag, 'dt must be an array of safe integers')
  }
  if (dt.length !== payload.length - 1) {
    malformed(tag, `dt length ${dt.length} does not match ${payload.length} members`)
  }
  return payload as string[]
}

function validateRow(value: Record<string, unknown>, tag: ChunkRow['type']): ChunkRow {
  if (!hasExactKeys(value, ['type', 'seq0', 'time0', 'data'])) {
    malformed(tag, 'envelope must be exactly {type, seq0, time0, data}')
  }
  if (!Number.isSafeInteger(value.seq0) || (value.seq0 as number) < 0 || Object.is(value.seq0, -0)) {
    malformed(tag, 'seq0 must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(value.time0)) {
    malformed(tag, 'time0 must be a safe integer')
  }
  const data = value.data
  if (!isRecord(data)) malformed(tag, 'data must be an object')
  let payload: string[]
  if (tag === 'tool-call-chunks') {
    const withName = hasExactKeys(data, ['turn', 'step', 'index', 'id', 'name', 'dt', 'args'])
    if (!withName && !hasExactKeys(data, ['turn', 'step', 'index', 'id', 'dt', 'args'])) {
      malformed(tag, 'data must be exactly {turn, step, index, id, name?, dt, args}')
    }
    if (typeof data.id !== 'string' || (withName && typeof data.name !== 'string')) {
      malformed(tag, 'id (and name when present) must be strings')
    }
    payload = validateRunData(tag, data, 'args')
  } else {
    if (!hasExactKeys(data, ['turn', 'step', 'index', 'dt', 'texts'])) {
      malformed(tag, 'data must be exactly {turn, step, index, dt, texts}')
    }
    payload = validateRunData(tag, data, 'texts')
  }
  if (payload.length - 1 > Number.MAX_SAFE_INTEGER - (value.seq0 as number)) {
    malformed(tag, 'member seqs must stay safe integers')
  }
  let time = value.time0 as number
  for (const gap of data.dt as number[]) {
    time += gap
    if (!Number.isSafeInteger(time)) malformed(tag, 'member times must stay safe integers')
  }
  SessionSeq(value.seq0 as number)
  return value as unknown as ChunkRow
}

function expandRow(row: ChunkRow): DeltaEvent[] {
  const members = row.type === 'tool-call-chunks' ? row.data.args : row.data.texts
  const events: DeltaEvent[] = []
  let time = row.time0
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += row.data.dt[k - 1] as number
    let chunk: StreamChunk
    switch (row.type) {
      case 'text-chunks':
        chunk = { type: 'text-delta', index: row.data.index, text: members[k] as string }
        break
      case 'reasoning-chunks':
        chunk = { type: 'reasoning-delta', index: row.data.index, text: members[k] as string }
        break
      case 'tool-call-chunks':
        chunk = {
          type: 'tool-call-delta',
          index: row.data.index,
          id: row.data.id,
          ...Object.hasOwn(row.data, 'name') ? { name: row.data.name as string } : {},
          argumentsDelta: members[k] as string,
        }
        break
    }
    events.push({
      type: 'assistant/chunk',
      seq: SessionSeq(row.seq0 + k),
      time,
      data: { turn: row.data.turn, step: row.data.step, chunk },
    })
  }
  return events
}

export function decodeStorageRecord(value: unknown): SessionEvent[] {
  if (!isRecord(value)) return [value as SessionEvent]
  const tag = value.type
  if (tag !== 'text-chunks' && tag !== 'reasoning-chunks' && tag !== 'tool-call-chunks') {
    if (typeof value.seq === 'number') SessionSeq(value.seq)
    return [value as unknown as SessionEvent]
  }
  return expandRow(validateRow(value, tag)) as unknown as SessionEvent[]
}
