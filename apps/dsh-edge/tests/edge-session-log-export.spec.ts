/// <reference types="node" />
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type FileAttachmentRef, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { readSessionLogText, streamSessionLogZip } from '@deepseek-ai/dsh-session-log-export'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import DurableObjectSessionPersistence from '../src/do-session-persistence.ts'
import {
  sessionLogExportResponse,
  type SessionLogExportSources,
  type SessionLogLineageNode,
} from '../src/edge-session-log-export.ts'
import { TestDurableObjectStorage } from './main-session-queue.spec.ts'

const root = SessionId('export-root')
const child = SessionId('export-child')
const grandchild = SessionId('export-grandchild')
const blank = SessionId('export-blank')
const image = (letter: string): ImageAttachmentRef => ({
  attachmentId: AttachmentId(`sha256:${letter.repeat(64)}`), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
})
const file = (letter: string, name: string): FileAttachmentRef => ({ attachmentId: AttachmentId(`sha256:${letter.repeat(64)}`), name, bytes: 5 })
const IMAGE_A = image('a')
const IMAGE_B = image('b')
const FILE_C = file('c', 'notes/../report.md')

function userMessage(seq: number, content: Parameters<typeof createUserMessage>[0]['content']): SessionEvent {
  return { type: 'user/message', seq: SessionSeq(seq), time: 1_000 + seq, surfaceOp: 'append', data: createUserMessage({ content, source: { kind: 'user' } }) } as SessionEvent
}
function assistantMessage(seq: number, text: string): SessionEvent {
  return {
    type: 'assistant/message', seq: SessionSeq(seq), time: 1_000 + seq, surfaceOp: 'append',
    data: { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }) },
  } as SessionEvent
}
function header(id: SessionId, parent?: SessionId): SessionHeader {
  return { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace', ...parent === undefined ? {} : { parentSession: parent, origin: 'subagent' as const, delegationDepth: 1 } }
}

async function fixture() {
  const storage = new TestDurableObjectStorage()
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(DurableObjectSessionPersistence, { storage: storage as never })
  const persistence = ctx.sessionPersistence as DurableObjectSessionPersistence
  const write = (meta: SessionHeader, events: SessionEvent[]) => persistence.appendBatch({ meta, inheritedEventCount: SessionLogOffset(0) }, events, false)
  // Chinese text, an image shown twice (one archive entry), and a file whose name needs sanitizing.
  await write(header(root), [
    userMessage(0, [{ type: 'text', text: '看看这张图'.repeat(30) }, { type: 'image', attachment: IMAGE_A }]),
    assistantMessage(1, '好的'.repeat(200)),
    userMessage(2, [{ type: 'image', attachment: IMAGE_A }, { type: 'file', attachment: FILE_C }]),
    ...Array.from({ length: 9 }, (_, index) => assistantMessage(3 + index, `第 ${String(index)} 段 😀`.repeat(40))),
  ])
  await write(header(child, root), [userMessage(0, [{ type: 'image', attachment: IMAGE_B }]), assistantMessage(1, 'child')])
  await write(header(grandchild, child), [userMessage(0, [{ type: 'text', text: 'grandchild' }])])
  const lineage: SessionLogLineageNode[] = [{
    session: { header: { id: child } },
    descendants: [{ session: { header: { id: grandchild } }, descendants: [] }],
  }]
  const attachments = {
    readImage: (ref: ImageAttachmentRef) => Promise.resolve({ ref, data: new TextEncoder().encode(`png ${String(ref.attachmentId)}`) }),
    readFileStream: async function* (ref: FileAttachmentRef) {
      yield new TextEncoder().encode('# report ')
      yield new TextEncoder().encode(String(ref.attachmentId))
    },
  }
  const sources = (rows: number, characters: number): SessionLogExportSources & { pageSizes: number[] } => {
    const pageSizes: number[] = []
    return {
      pageSizes,
      flush: () => Promise.resolve(),
      header: async (id, signal) => {
        try {
          await using handle = await persistence.open(id, 'read', { signal })
          return handle.header
        } catch (error) {
          if (error instanceof SessionPersistenceNotFoundError) return undefined
          throw error
        }
      },
      pages: async function* (id, signal) {
        for await (const page of persistence.exportEventPages(id, { rows, characters }, signal)) {
          pageSizes.push(page.length)
          yield page
        }
      },
      descendants: () => Promise.resolve(lineage),
      readImage: ref => attachments.readImage(ref),
      readFileStream: ref => attachments.readFileStream(ref),
    }
  }
  const upstream = async (id: SessionId, includeDescendants: boolean) => {
    const deps = {
      sessionQuery: { traceSession: () => Promise.resolve({ descendants: lineage }) },
      sessionPersistence: persistence,
      attachments,
      sessions: undefined,
    }
    const rootContent = await readSessionLogText(persistence, id)
    if (rootContent === undefined) throw new Error('missing fixture session')
    return await unzipped(new Response(streamSessionLogZip(deps as never, rootContent, id, includeDescendants, 6, new AbortController().signal)))
  }
  return { storage, persistence, write, sources, upstream, dispose: async () => { await fiber.dispose(); storage.close() } }
}

async function unzipped(response: Response): Promise<Record<string, string>> {
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()))
  return Object.fromEntries(Object.entries(entries).map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]))
}

describe('paged session log export', () => {
  it('builds the same archive as upstream\'s exporter, with or without subagents, however the log is paged', async () => {
    const { sources, upstream, dispose } = await fixture()
    try {
      for (const includeDescendants of [true, false]) {
        const expected = await upstream(root, includeDescendants)
        // Media and files after the logs, so the archive covers attachments of every included log.
        expect(Object.keys(expected)).toEqual(includeDescendants
          ? ['session.v4.jsonl', `subagents/${child}/session.v4.jsonl`, `subagents/${grandchild}/session.v4.jsonl`,
            `media/${String(IMAGE_A.attachmentId)}.png`, `media/${String(IMAGE_B.attachmentId)}.png`, `files/cc/${'c'.repeat(64)}/notes_.._report.md`]
          : ['session.v4.jsonl', `media/${String(IMAGE_A.attachmentId)}.png`, `files/cc/${'c'.repeat(64)}/notes_.._report.md`])
        for (const [rows, characters] of [[1, Number.MAX_SAFE_INTEGER], [5, 2_000], [1_000, Number.MAX_SAFE_INTEGER]] as const) {
          const source = sources(rows, characters)
          const actual = await unzipped(await sessionLogExportResponse(source, root, includeDescendants, new AbortController().signal))
          expect(Object.keys(actual)).toEqual(Object.keys(expected))
          expect(actual).toEqual(expected)
          if (rows === 1) expect(source.pageSizes.slice(0, 12)).toEqual(Array.from({ length: 12 }, () => 1))
        }
      }
    } finally { await dispose() }
  })

  it('exports a blank session as its header line, like upstream', async () => {
    const { persistence, sources, dispose } = await fixture()
    try {
      // A blank session keeps only its header until its first event.
      await persistence.retainBlankSession(header(blank))
      const response = await sessionLogExportResponse(sources(10, 1_000), blank, false, new AbortController().signal)
      const lines = (await unzipped(response))['session.v4.jsonl']?.split('\n')
      expect(lines).toEqual([expect.stringContaining(`"id":"${String(blank)}"`) as unknown, ''])
    } finally { await dispose() }
  })

  it('answers 404 for a missing session and 500 when the log cannot be opened, before any archive byte', async () => {
    const { sources, dispose } = await fixture()
    try {
      const response = await sessionLogExportResponse(sources(10, 1_000), SessionId('export-missing'), false, new AbortController().signal)
      expect(response.status).toBe(404)
      const broken = { ...sources(10, 1_000), header: () => Promise.reject(new Error('storage offline')) }
      expect((await sessionLogExportResponse(broken, root, false, new AbortController().signal)).status).toBe(500)
    } finally { await dispose() }
  })

  it('ends the stream with an error, not a short archive, when a subagent log is missing or a page fails', async () => {
    const { sources, dispose } = await fixture()
    try {
      const missingChild = { ...sources(10, 1_000), header: (id: SessionId) => Promise.resolve(id === child ? undefined : header(id)) }
      const response = await sessionLogExportResponse(missingChild, root, true, new AbortController().signal)
      expect(response.status).toBe(200)
      await expect(response.arrayBuffer()).rejects.toThrow(`subagent "${String(child)}" has no stored log`)
      const failingPage = {
        ...sources(1, 1_000),
        pages: async function* () {
          yield [] as SessionEvent[]
          throw new Error('page read failed')
        },
      }
      await expect((await sessionLogExportResponse(failingPage, root, false, new AbortController().signal)).arrayBuffer()).rejects.toThrow('page read failed')
    } finally { await dispose() }
  })

  it('reads no further than the reader takes: a cancelled download stops paging', async () => {
    const { write, sources, dispose } = await fixture()
    const large = SessionId('export-large')
    try {
      // About 4 MiB of incompressible text, far beyond the response queue.
      const noise = (seq: number) => Array.from({ length: 4_000 }, (_, index) => ((seq * 7_919 + index * 104_729) % 65_521).toString(36)).join('')
      await write(header(large), Array.from({ length: 200 }, (_, seq) => assistantMessage(seq, noise(seq))))
      const source = sources(1, Number.MAX_SAFE_INTEGER)
      const response = await sessionLogExportResponse(source, large, false, new AbortController().signal)
      const reader = response.body!.getReader()
      await reader.read()
      await new Promise(resolve => setTimeout(resolve, 20))
      const pagesBeforeCancel = source.pageSizes.length
      expect(pagesBeforeCancel).toBeLessThan(20)
      await reader.cancel()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(source.pageSizes.length).toBeLessThanOrEqual(pagesBeforeCancel + 1)
    } finally { await dispose() }
  })
})
