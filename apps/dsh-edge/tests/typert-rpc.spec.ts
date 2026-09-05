import { describe, expect, it } from 'vitest'

const TYPERT_URL_PATTERN = /^\/api\/([a-zA-Z0-9_$.-]+)\/([a-zA-Z0-9_$.-]+)$/

describe('Typert RPC URL matching', () => {
  it('matches two-segment namespace/method paths', () => {
    const match = TYPERT_URL_PATTERN.exec('/api/goals/edit')
    expect(match).not.toBeNull()
    expect(match![1]).toBe('goals')
    expect(match![2]).toBe('edit')
  })

  it('matches dotted namespace segments', () => {
    const match = TYPERT_URL_PATTERN.exec('/api/file.reference/files')
    expect(match).not.toBeNull()
    expect(match![1]).toBe('file.reference')
    expect(match![2]).toBe('files')
  })

  it('matches the gateway-owned forwarded-event result endpoint', () => {
    const match = TYPERT_URL_PATTERN.exec('/api/$events/result')
    expect(match).not.toBeNull()
    expect(match![1]).toBe('$events')
    expect(match![2]).toBe('result')
  })

  it('rejects single-segment apiproxy paths', () => {
    expect(TYPERT_URL_PATTERN.exec('/api/goal.edit')).toBeNull()
    expect(TYPERT_URL_PATTERN.exec('/api/session.list')).toBeNull()
  })

  it('rejects event stream paths', () => {
    expect(TYPERT_URL_PATTERN.exec('/api/events.mux')).toBeNull()
    expect(TYPERT_URL_PATTERN.exec('/api/events.host')).toBeNull()
  })

  it('rejects paths with extra segments', () => {
    expect(TYPERT_URL_PATTERN.exec('/api/goals/edit/extra')).toBeNull()
  })

  it('rejects bare /api/ path', () => {
    expect(TYPERT_URL_PATTERN.exec('/api/')).toBeNull()
  })
})
