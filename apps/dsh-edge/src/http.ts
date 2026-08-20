/** Shared HTTP parsing, response, and error translation for dsh-edge routes. */

import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { EdgeSessionStoreError } from './session-store.ts'
import { EdgeWorkspaceRequestError } from './workspace.ts'

const textEncoder = new TextEncoder()

export const MAX_SESSION_CREATE_BODY_BYTES = 8_192
export const MAX_TURN_BODY_BYTES = 524_288
export const MAX_WORKSPACE_EXEC_BODY_BYTES = 131_072

/** Invalid caller input with an explicit HTTP response status. */
export class EdgeHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** Consume a request body without retaining bytes beyond its route limit. */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
  message: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get('content-length')
  let exceeded = declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes
  if (request.body === null) return new Uint8Array()

  const chunks: Uint8Array[] = []
  let byteLength = 0
  const stream = request.body as ReadableStream<Uint8Array>
  const reader = stream.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      byteLength += next.value.byteLength
      if (exceeded || byteLength > maxBytes) {
        exceeded = true
        chunks.length = 0
        continue
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  if (exceeded) throw new EdgeHttpError(413, message)

  const body = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** Consume one bounded UTF-8 request body. */
export async function readBoundedText(
  request: Request,
  maxBytes: number,
  message: string,
): Promise<string> {
  const body = await readBoundedBody(request, maxBytes, message)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new EdgeHttpError(400, 'The request body must contain valid UTF-8.')
  }
}

/** Parse a size-bounded JSON object request body. */
export async function readJsonObject(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  try {
    const source = await readBoundedText(
      request,
      maxBytes,
      `JSON request bodies are limited to ${maxBytes} bytes.`,
    )
    const body: unknown = JSON.parse(source)
    if (!isRecord(body)) {
      throw new EdgeHttpError(400, 'The request body must be a JSON object.')
    }
    return body
  } catch (error) {
    if (error instanceof EdgeHttpError) throw error
    throw new EdgeHttpError(400, 'The request body must contain valid JSON.')
  }
}

/** Release an unread request body before returning an early Worker response. */
export async function discardUnreadRequestBody(request: Request): Promise<void> {
  if (request.body === null || request.bodyUsed) return
  await request.body.cancel().catch(() => undefined)
}

/** Validate a non-empty bounded string field from an HTTP request. */
export function requireBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EdgeHttpError(400, `${field} must be a non-empty string.`)
  }
  if (value.length > maxLength) {
    throw new EdgeHttpError(413, `${field} is limited to ${maxLength} characters.`)
  }
  return value
}

/** Validate a non-empty string field whose wire limit is defined in UTF-8 bytes. */
export function requireBoundedUtf8String(
  value: unknown,
  field: string,
  maxBytes: number,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EdgeHttpError(400, `${field} must be a non-empty string.`)
  }
  if (textEncoder.encode(value).byteLength > maxBytes) {
    throw new EdgeHttpError(413, `${field} is limited to ${maxBytes} UTF-8 bytes.`)
  }
  return value
}

/** Resolve the deployment-scoped DeepSeek Worker secret. */
export function resolveDeepSeekApiKey(configuredKey?: string): string {
  const apiKey = configuredKey
  if (apiKey === undefined) {
    throw new EdgeHttpError(
      401,
      'Configure the DEEPSEEK_API_KEY Worker secret.',
    )
  }
  return assertUsableApiKey(
    apiKey,
    'dsh-edge',
    'DEEPSEEK_API_KEY',
  )
}

/** Build one JSON response with the development CORS policy. */
export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: corsHeaders() })
}

/** Development-only CORS headers shared by every route. */
export function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-headers': 'content-type, last-event-id',
    'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'x-dsh-edge-has-more, x-dsh-edge-next-after',
  }
}

/** Translate known runtime failures without exposing stacks or credentials. */
export function errorResponse(error: unknown): Response {
  if (error instanceof EdgeHttpError || error instanceof EdgeWorkspaceRequestError) {
    return jsonResponse({ ok: false, error: error.message }, error.status)
  }
  if (error instanceof EdgeSessionStoreError) {
    const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'BUSY' ? 409 : 500
    return jsonResponse({ ok: false, error: error.message, code: error.code }, status)
  }
  if (error instanceof LlmError) {
    return jsonResponse({
      ok: false,
      error: error.message,
      code: error.code,
      ...error.failure.status === undefined
        ? {}
        : { providerStatus: error.failure.status },
      ...error.failure.requestId === undefined
        ? {}
        : { providerRequestId: error.failure.requestId },
    }, llmHttpStatus(error.code))
  }
  if (isErrorCode(error, 'ENOENT')) {
    return jsonResponse({ ok: false, error: 'Workspace entry not found.' }, 404)
  }
  console.error(error)
  return jsonResponse({ ok: false, error: 'Internal runtime error.' }, 500)
}

function llmHttpStatus(code: string): number {
  if (code === 'AUTH' || code === 'MISSING_CREDENTIAL') return 401
  if (code === 'INVALID_CREDENTIAL'
    || code === 'INVALID_REQUEST'
    || code === 'CONTEXT_WINDOW_EXCEEDED') return 400
  if (code === 'RATE_LIMIT' || code === 'QUOTA') return 429
  if (code === 'TIMEOUT') return 504
  return 502
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code
}
