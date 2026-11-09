import { describe, expect, it } from 'vitest'
import { handlePublicChatRoute, isPublicChatEnabled, publicMaxTokens, validatePublicMessages } from '../src/public-chat.ts'

describe('anonymous chat boundary', () => {
  it('is opt-in', () => {
    expect(isPublicChatEnabled({})).toBe(false)
    expect(isPublicChatEnabled({ DSH_EDGE_PUBLIC_CHAT: 'enabled' })).toBe(true)
    expect(isPublicChatEnabled({ DSH_EDGE_PUBLIC_CHAT: 'false' })).toBe(false)
  })
  it('never accepts caller-selected model or secret fields as messages', () => {
    expect(validatePublicMessages([{ role: 'user', content: 'Xin chào', model: 'evil', apiKey: 'evil' }]))
      .toEqual([{ role: 'user', content: 'Xin chào' }])
    expect(() => validatePublicMessages([{ role: 'tool', content: 'test' }])).toThrow()
    expect(() => validatePublicMessages([{ role: 'assistant', content: 'not a user turn' }])).toThrow()
    expect(() => validatePublicMessages([{ role: 'user', content: 'x'.repeat(6001) }])).toThrow()
    expect(() => validatePublicMessages([])).toThrow()
  })
  it('bounds per-turn output', () => {
    expect(publicMaxTokens(undefined)).toBe(1024)
    expect(publicMaxTokens('2048')).toBe(2048)
    expect(() => publicMaxTokens('90000')).toThrow()
  })
  it('returns public Vietnamese HTML without owner auth', async () => {
    const response = await handlePublicChatRoute(new Request('https://test.example/'), {})
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('BilaBot')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
  })
  it('rejects cross-origin and does not call upstream', async () => {
    const response = await handlePublicChatRoute(new Request('https://test.example/api/public/chat', {
      method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    }), { DEEPSEEK_API_KEY: 'test-secret' })
    expect(response.status).toBe(403)
  })
  it('never reveals the API key from config', async () => {
    const response = await handlePublicChatRoute(new Request('https://test.example/api/public/config'),
      { DEEPSEEK_API_KEY: 'very-private', DEEPSEEK_MODEL: 'deepseek-flash' })
    const source = await response.text()
    expect(source).not.toContain('very-private')
    expect(JSON.parse(source)).toMatchObject({ ready: true, model: 'deepseek-flash' })
  })
  it('rejects misconfigured rate limiting instead of exposing a free public proxy', async () => {
    const response = await handlePublicChatRoute(new Request('https://test.example/api/public/chat', {
      method: 'POST', headers: { origin: 'https://test.example', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    }), { DEEPSEEK_API_KEY: 'test-secret' })
    expect(response.status).toBe(503)
  })
})
