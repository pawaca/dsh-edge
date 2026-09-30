import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { edgeSearchDocuments } from '../src/edge-session-query.ts'
import type {} from '../src/upstream-message-sources.ts'

function userMessage(seq: number, text: string, source: Record<string, unknown>): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: 1_000 + seq,
    surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text }], source: source as never }),
  } as unknown as SessionEvent
}

describe('Edge session search documents', () => {
  it('indexes what the owner said and leaves injected context out', () => {
    const events = [
      userMessage(0, 'owner asks about rivers', { kind: 'user' }),
      userMessage(1, 'Current date: Tuesday', { kind: 'runtime-context', form: 'snapshot', sections: [] }),
      userMessage(2, 'skills available: greet-owner', { kind: 'skill-catalog', form: 'catalog', entries: [] }),
      userMessage(3, 'The bash command may still be running', { kind: 'edge-shell', form: 'notice', summary: 'still running' }),
      userMessage(4, 'recalled from another session', { kind: 'session-reference', form: 'recall', version: 1, references: [] }),
      userMessage(5, 'reminder: water the plants', { kind: 'schedule' }),
    ]
    expect(edgeSearchDocuments(SessionId('s'), events).map(document => document.text))
      .toEqual(['owner asks about rivers', 'reminder: water the plants'])
  })
})
