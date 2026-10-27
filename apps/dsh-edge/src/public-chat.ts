/** Optional Vietnamese, anonymous, stateless chat surface.
 * Deliberately does NOT call the Harness session/agent/DO APIs: they persist data
 * and expose tools intended for the single owner. No chat content is stored here.
 */
import { resolveEdgeModel } from './deepseek.ts'
import { EdgeHttpError, readJsonObject } from './http.ts'
import { publicChatHtml, publicChatJavascript } from './public-chat-page.ts'

export interface PublicChatEnv {
  DSH_EDGE_PUBLIC_CHAT?: string
  DSH_EDGE_PUBLIC_MAX_TOKENS?: string
  DEEPSEEK_API_KEY?: string
  DEEPSEEK_MODEL?: string
  PUBLIC_CHAT_RATE_LIMITER?: { limit: (input: { key: string }) => Promise<{ success: boolean }> }
}

const MAX_BODY_BYTES = 64 * 1024
const MAX_MESSAGE_COUNT = 20
const MAX_MESSAGE_CHARS = 6_000
const MAX_TOTAL_CHARS = 28_000
const MODEL_ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages'
type ChatMessage = { role: 'user' | 'assistant'; content: string }

export function isPublicChatEnabled(env: PublicChatEnv): boolean {
  return env.DSH_EDGE_PUBLIC_CHAT === 'enabled'
}

function headers(contentType = 'application/json; charset=utf-8'): Headers {
  return new Headers({
    'content-type': contentType,
    'cache-control': 'private, no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-resource-policy': 'same-origin',
  })
}

function result(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: headers() })
}

function error(status: number, message: string): Response {
  return result({ ok: false, error: message }, status)
}

export function publicMaxTokens(value: string | undefined): number {
  if (value === undefined) return 1024
  if (!/^\d{1,4}$/u.test(value) || Number(value) < 128 || Number(value) > 2048) {
    throw new Error('DSH_EDGE_PUBLIC_MAX_TOKENS phải trong khoảng 128–2048.')
  }
  return Number(value)
}

export function validatePublicMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MESSAGE_COUNT) {
    throw new EdgeHttpError(400, 'Hội thoại phải có từ 1 đến 20 tin nhắn.')
  }
  let total = 0
  const messages: ChatMessage[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new EdgeHttpError(400, 'Định dạng tin nhắn không hợp lệ.')
    }
    const msg = raw as Record<string, unknown>
    if ((msg.role !== 'user' && msg.role !== 'assistant') || typeof msg.content !== 'string'
      || msg.content.trim().length === 0 || msg.content.length > MAX_MESSAGE_CHARS) {
      throw new EdgeHttpError(400, 'Tin nhắn không hợp lệ hoặc quá dài.')
    }
    total += msg.content.length
    messages.push({ role: msg.role, content: msg.content })
  }
  if (total > MAX_TOTAL_CHARS) throw new EdgeHttpError(413, 'Hội thoại quá dài, hãy tạo cuộc trò chuyện mới.')
  if (messages.at(-1)?.role !== 'user') throw new EdgeHttpError(400, 'Tin nhắn cuối phải do người dùng gửi.')
  return messages
}

/** Public-mode routes never forward requests into persistent owner APIs. */
export async function handlePublicChatRoute(request: Request, env: PublicChatEnv): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/public')) {
    const h = headers('text/html; charset=utf-8')
    h.set('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    return new Response(publicChatHtml, { headers: h })
  }
  if (request.method === 'GET' && url.pathname === '/public/app.js') {
    return new Response(publicChatJavascript, { headers: headers('text/javascript; charset=utf-8') })
  }
  if (request.method === 'GET' && url.pathname === '/api/public/config') {
    try {
      return result({ ok: true, model: resolveEdgeModel(env.DEEPSEEK_MODEL), ready: Boolean(env.DEEPSEEK_API_KEY?.trim()) })
    } catch {
      return error(503, 'Cấu hình mô hình chưa hợp lệ.')
    }
  }
  if (request.method !== 'POST' || url.pathname !== '/api/public/chat') {
    return error(404, 'Không tìm thấy trang hoặc API.')
  }

  // A browser page from another origin must not be allowed to spend this key.
  // This is CSRF protection, not anti-bot authentication; WAF rules still matter.
  if (request.headers.get('origin') !== url.origin
    || request.headers.get('sec-fetch-site') === 'cross-site') {
    return error(403, 'Chỉ chấp nhận yêu cầu từ website này.')
  }
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return error(415, 'Yêu cầu phải ở định dạng JSON.')
  }
  if (!env.DEEPSEEK_API_KEY?.trim()) return error(503, 'Chủ website chưa cấu hình API key.')
  if (env.PUBLIC_CHAT_RATE_LIMITER === undefined) {
    return error(503, 'Chưa cấu hình giới hạn truy cập công khai.')
  }

  try {
    const model = resolveEdgeModel(env.DEEPSEEK_MODEL)
    const maxTokens = publicMaxTokens(env.DSH_EDGE_PUBLIC_MAX_TOKENS)
    const payload = await readJsonObject(request, MAX_BODY_BYTES)
    const messages = validatePublicMessages(payload.messages)
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    const limited = await env.PUBLIC_CHAT_RATE_LIMITER.limit({ key: `public-chat:${ip}` })
    if (!limited.success) return error(429, 'Bạn đã gửi quá nhiều yêu cầu. Vui lòng thử lại sau một phút.')

    const upstream = await fetch(MODEL_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.DEEPSEEK_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: 'Bạn là BilaBot, trợ lý AI hỗ trợ tiếng Việt. Trả lời rõ ràng, hữu ích và trung thực.',
        messages,
        stream: false,
      }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!upstream.ok) {
      // Never expose provider response bodies: they might contain account metadata.
      return error(upstream.status === 429 ? 429 : 502,
        upstream.status === 429 ? 'Dịch vụ AI đang giới hạn yêu cầu. Hãy thử lại sau.' : 'Không thể kết nối với dịch vụ AI.')
    }
    const reply = await upstream.json() as {
      content?: Array<{ type?: string; text?: string }>
    }
    const answer = reply.content?.filter(block => block.type === 'text')
      .map(block => block.text ?? '').join('\n').trim()
    if (!answer) return error(502, 'Dịch vụ AI chưa trả về nội dung.')
    return result({ ok: true, answer, model })
  } catch (cause) {
    if (cause instanceof EdgeHttpError) return error(cause.status, cause.message)
    // Never log or echo the request, upstream headers, keys or prompt.
    return error(503, 'Tạm thời không thể xử lý yêu cầu. Vui lòng thử lại.')
  }
}
