import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  CAPTURE_ROOT,
  EdgeWorkspaceChanges,
  MAX_COMPARE_LINES,
  compareText,
  type EdgeChangesFiles,
} from '../src/edge-workspace-changes.ts'

/** In-memory Computer workspace files, counting writes. */
function memoryFiles() {
  const files = new Map<string, Uint8Array>()
  const writes: string[] = []
  const api: EdgeChangesFiles = {
    stat(path) {
      const bytes = files.get(path)
      if (bytes === undefined) return Promise.reject(Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' }))
      return Promise.resolve({ size: bytes.byteLength, isFile: true })
    },
    readFile(path) {
      const bytes = files.get(path)
      if (bytes === undefined) return Promise.reject(Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' }))
      return Promise.resolve(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }))
    },
    writeFile(path, content) { writes.push(path); files.set(path, content); return Promise.resolve() },
    mkdir() { return Promise.resolve() },
    rm(path) {
      for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key)
      return Promise.resolve()
    },
  }
  const put = (path: string, text: string | Uint8Array) => files.set(path, typeof text === 'string' ? new TextEncoder().encode(text) : text)
  return { files, writes, api, put }
}

interface FakeSession {
  id: string
  header: { cwd: string, origin?: string, delegationDepth?: number }
  appended: Array<{ type: string, data: unknown, seq: number }>
  append(type: string, data: unknown): { seq: number }
}

function fakeSession(id: string, header: FakeSession['header'] = { cwd: '/workspace' }): FakeSession {
  let seq = 100
  const session: FakeSession = {
    id, header, appended: [],
    append(type, data) { const event = { type, data, seq: seq++ }; session.appended.push(event); return event },
  }
  return session
}

async function setup(options: { maxFileBytes?: number } = {}) {
  const root = new Context()
  root.provide('fs')
  root.set('fs', { processPath: (target: { path: string }) => target.path })
  const memory = memoryFiles()
  await root.plugin(EdgeWorkspaceChanges, { withFiles: run => run(memory.api), ...options })
  const exec = (session: FakeSession) => ({ agent: { session } })
  const emit = (name: string, ...args: unknown[]) => { (root.emit as unknown as (...rest: unknown[]) => void).call(root, name, ...args) }
  /** One turn: start, the file-tool writes (each applied after its capture), a tool result, then stop and end. */
  const runTurn = async (session: FakeSession, turn: number, edits: Array<[string, string | Uint8Array | null]>) => {
    emit('session/event', session, { type: 'turn/start', seq: 1, data: { turn } })
    for (const [path, content] of edits) {
      const actor = exec(session)
      await (root as unknown as { waterfall: (...args: unknown[]) => Promise<unknown> }).waterfall('tools/pre-execute', actor, () => Promise.resolve({ kind: 'run' }))
      await (root as unknown as { waterfall: (...args: unknown[]) => Promise<unknown> }).waterfall('fs/write-intent', { path }, actor, () => undefined)
      if (content === null) memory.files.delete(path)
      else memory.put(path, content)
    }
    emit('session/event', session, { type: 'tool/result', seq: 50 + turn, data: { turn } })
    await (root.parallel as unknown as (...rest: unknown[]) => Promise<unknown>).call(root, 'agent/turn-stopping', { agent: { session }, turn })
    emit('session/event', session, { type: 'turn/end', seq: 60 + turn, data: { turn } })
  }
  const service = () => root.get('workspaceChanges') as import('@deepseek-ai/dsh-workspace-changes/types').WorkspaceChanges
  return { emit, memory, runTurn, service }
}

describe('compareText', () => {
  it('counts lines, treats a missing final newline as unchanged, and degrades on timeout', () => {
    expect(compareText('a\nb\n', 'a\nB\n', 100)).toMatchObject({ added: 1, deleted: 1, coarse: false })
    expect(compareText('a\nb', 'a\nb\n', 100)).toMatchObject({ added: 0, deleted: 0, hunks: [] })
    expect(compareText(null, 'x\n', 100).hunks).toEqual([{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+x'] }])
    const big = (prefix: string) => Array.from({ length: 4000 }, (_, i) => `${prefix}${String(i)}`).join('\n')
    const slow = compareText(big('a'), big('b'), 0)
    expect(slow.coarse).toBe(true)
    expect(slow.hunks).toHaveLength(1)
    expect(slow).toMatchObject({ added: 4000, deleted: 4000 })
  })
})

describe('EdgeWorkspaceChanges', () => {
  it('summarizes a turn\'s file-tool edits and serves their comparisons', async () => {
    const { memory, runTurn, service } = await setup()
    memory.put('/workspace/kept.txt', 'one\ntwo\n')
    memory.put('/workspace/same.txt', 'same\n')
    memory.put('/workspace/gone.txt', 'bye\n')
    const session = fakeSession('s1')
    await runTurn(session, 1, [
      ['/workspace/kept.txt', 'one\nTWO\n'],
      ['/workspace/new.txt', 'n\n'],
      ['/workspace/same.txt', 'same\n'],
      ['/workspace/gone.txt', null],
      ['/outside/abs.txt', 'x\n'],
      ['/tmp/scratch.txt', 'tmp\n'],
    ])
    expect(session.appended.map(event => event.type)).toEqual(['workspace/changes'])
    const seq = session.appended[0]!.seq
    const summary = service().summary('s1' as never, seq)
    expect(summary).toEqual({
      turn: 1, cwd: '/workspace', total: 4, added: 3, deleted: 2,
      files: [
        { path: '/outside/abs.txt', display: '/outside/abs.txt', added: 1, deleted: 0 },
        { path: 'gone.txt', display: 'gone.txt', added: 0, deleted: 1 },
        { path: 'kept.txt', display: 'kept.txt', added: 1, deleted: 1 },
        { path: 'new.txt', display: 'new.txt', added: 1, deleted: 0 },
      ],
    })
    expect(await service().diff('s1' as never, seq, 1, AbortSignal.timeout(5000))).toEqual({
      kind: 'text', path: 'gone.txt', display: 'gone.txt', before: true, after: false, coarse: false,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['-bye'] }],
    })
    expect(await service().diff('s1' as never, seq, 9, AbortSignal.timeout(5000))).toBeUndefined()
    expect(service().summary('s1' as never, seq + 1)).toBeUndefined()
    // Each distinct content is copied once, under the capture root.
    expect(memory.writes.every(path => path.startsWith(`${CAPTURE_ROOT}/s1/`))).toBe(true)
    expect(new Set(memory.writes).size).toBe(memory.writes.length)
  })

  it('lists oversized and binary files without counts or lines', async () => {
    const { memory, runTurn, service } = await setup({ maxFileBytes: 16 })
    memory.put('/workspace/big.txt', 'x'.repeat(10))
    memory.put('/workspace/bin.dat', new Uint8Array([1, 0, 2]))
    const session = fakeSession('s2')
    await runTurn(session, 1, [['/workspace/big.txt', 'y'.repeat(40)], ['/workspace/bin.dat', new Uint8Array([1, 0, 3])]])
    const seq = session.appended[0]!.seq
    expect(service().summary('s2' as never, seq)?.files).toEqual([
      { path: 'big.txt', display: 'big.txt', added: 0, deleted: 0, oversized: true },
      { path: 'bin.dat', display: 'bin.dat', added: 0, deleted: 0, binary: true },
    ])
    expect(await service().diff('s2' as never, seq, 0, AbortSignal.timeout(5000))).toEqual({ kind: 'oversized', path: 'big.txt', display: 'big.txt' })
    expect(await service().diff('s2' as never, seq, 1, AbortSignal.timeout(5000))).toEqual({ kind: 'binary', path: 'bin.dat', display: 'bin.dat' })
  })

  it('compares at most MAX_COMPARE_LINES lines a side and lists a longer file as oversized', async () => {
    const { memory, runTurn, service } = await setup()
    const lines = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => `${prefix}${String(i)}\n`).join('')
    memory.put('/workspace/edge.txt', lines(MAX_COMPARE_LINES, 'a'))
    memory.put('/workspace/long.txt', 'short\n')
    const session = fakeSession('lines')
    await runTurn(session, 1, [
      ['/workspace/edge.txt', lines(MAX_COMPARE_LINES - 1, 'a') + 'changed\n'],
      ['/workspace/long.txt', lines(MAX_COMPARE_LINES + 1, 'b')],
    ])
    const seq = session.appended[0]!.seq
    expect(service().summary('lines' as never, seq)?.files).toEqual([
      { path: 'edge.txt', display: 'edge.txt', added: 1, deleted: 1 },
      { path: 'long.txt', display: 'long.txt', added: 0, deleted: 0, oversized: true },
    ])
    expect(await service().diff('lines' as never, seq, 1, AbortSignal.timeout(5000))).toEqual({ kind: 'oversized', path: 'long.txt', display: 'long.txt' })
  })

  it('announces nothing for a turn without changes or for a subagent', async () => {
    const { memory, runTurn, service } = await setup()
    memory.put('/workspace/a.txt', 'a\n')
    const quiet = fakeSession('quiet')
    await runTurn(quiet, 1, [['/workspace/a.txt', 'a\n']])
    expect(quiet.appended).toEqual([])
    const subagent = fakeSession('child', { cwd: '/workspace', origin: 'subagent' })
    await runTurn(subagent, 1, [['/workspace/a.txt', 'changed\n']])
    expect(subagent.appended).toEqual([])
    expect(service().summary('child' as never, 100)).toBeUndefined()
  })

  it('removes a disposed session\'s copies, and the previous activation\'s before its first capture', async () => {
    const { emit, memory, runTurn } = await setup()
    memory.put(`${CAPTURE_ROOT}/stale/0123`, 'left by an earlier activation')
    memory.put('/workspace/a.txt', 'a\n')
    const session = fakeSession('s3')
    await runTurn(session, 1, [['/workspace/a.txt', 'b\n']])
    expect([...memory.files.keys()].some(path => path.startsWith(`${CAPTURE_ROOT}/stale/`))).toBe(false)
    expect([...memory.files.keys()].filter(path => path.startsWith(`${CAPTURE_ROOT}/s3/`))).toHaveLength(2)
    emit('session/disposed', session)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect([...memory.files.keys()].some(path => path.startsWith(CAPTURE_ROOT))).toBe(false)
  })
})
