import { describe, expect, it } from 'vitest'
import {
  MAX_MESSAGE_FEEDBACK_BODY_BYTES,
  MAX_SESSION_CREATE_BODY_BYTES,
  MAX_TURN_BODY_BYTES,
  instanceRequestBodyLimit,
} from '../src/http.ts'

describe('instanceRequestBodyLimit', () => {
  it('gives prompts the turn budget on both the legacy and the Typert route form', () => {
    expect(instanceRequestBodyLimit('/api/session.prompt')).toBe(MAX_TURN_BODY_BYTES)
    expect(instanceRequestBodyLimit('/api/session/prompt')).toBe(MAX_TURN_BODY_BYTES)
    expect(instanceRequestBodyLimit('/api/session.updateQueue')).toBe(MAX_TURN_BODY_BYTES)
    expect(instanceRequestBodyLimit('/api/session/updateQueue')).toBe(MAX_TURN_BODY_BYTES)
  })

  it('keeps the dedicated budgets for turns, skills, and message feedback', () => {
    expect(instanceRequestBodyLimit('/api/sessions/abc/turn')).toBe(MAX_TURN_BODY_BYTES)
    expect(instanceRequestBodyLimit('/api/skills')).toBe(MAX_TURN_BODY_BYTES)
    expect(instanceRequestBodyLimit('/api/messageFeedback/put')).toBe(MAX_MESSAGE_FEEDBACK_BODY_BYTES)
    expect(instanceRequestBodyLimit('/api/messageFeedback.put')).toBe(MAX_MESSAGE_FEEDBACK_BODY_BYTES)
  })

  it('leaves every other route on the small default', () => {
    expect(instanceRequestBodyLimit('/api/sessions')).toBe(MAX_SESSION_CREATE_BODY_BYTES)
    expect(instanceRequestBodyLimit('/api/session/list')).toBe(MAX_SESSION_CREATE_BODY_BYTES)
    expect(instanceRequestBodyLimit('/api/session.list')).toBe(MAX_SESSION_CREATE_BODY_BYTES)
    expect(instanceRequestBodyLimit('/api/workspace/create')).toBe(MAX_SESSION_CREATE_BODY_BYTES)
    expect(instanceRequestBodyLimit('/api/session/prompt/extra')).toBe(MAX_SESSION_CREATE_BODY_BYTES)
  })
})
