import {
  EdgeHttpError,
  readBoundedText,
} from './http.ts'
import { DSH_EDGE_UPGRADE_COMMAND } from './release.ts'
import { ownerPage } from './owner-page.ts'

const LOCAL_COOKIE_NAME = 'dsh_edge_owner'
const SECURE_COOKIE_NAME = '__Host-dsh_edge_owner'
const COOKIE_VERSION = 'v1'
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
const MAX_LOGIN_BODY_BYTES = 4_096
const MIN_ACCESS_KEY_BYTES = 32
const MAX_ACCESS_KEY_BYTES = 512
const SESSION_SIGNING_CONTEXT = 'dsh-edge-owner-session\0'
const OWNER_AUTH_CHALLENGE = 'DshEdgeOwner'
const textEncoder = new TextEncoder()

/** Trusted Worker-to-Durable-Object metadata; callers cannot select its value. */
export const OWNER_SESSION_EXPIRY_HEADER = 'x-dsh-edge-owner-session-expires-at'

/** Validated single-owner authentication configuration. */
export interface OwnerAuthConfig {
  accessKey: string
}

/** Claims recovered from a valid owner cookie. */
export interface OwnerSession {
  expiresAt: number
}

/** Fail closed unless the deployment has one suitably strong owner key. */
export function resolveOwnerAuthConfig(accessKey: string | undefined): OwnerAuthConfig {
  const byteLength = accessKey === undefined ? 0 : textEncoder.encode(accessKey).byteLength
  if (accessKey === undefined
    || byteLength < MIN_ACCESS_KEY_BYTES
    || byteLength > MAX_ACCESS_KEY_BYTES
    || accessKey.trim() !== accessKey
    // eslint-disable-next-line no-control-regex -- owner keys must reject ASCII controls.
    || /[\u0000-\u001f\u007f]/u.test(accessKey)) {
    throw new EdgeHttpError(
      503,
      'Owner authentication is not configured safely. Set DSH_EDGE_ACCESS_KEY to a random value of at least 32 bytes.',
    )
  }
  return { accessKey }
}

/** Handle the small login/session/logout surface owned by the Edge adapter. */
export async function handleOwnerAuthRoute(
  request: Request,
  config: OwnerAuthConfig,
): Promise<Response | undefined> {
  const url = new URL(request.url)

  if (request.method === 'GET' && url.pathname === '/login') {
    return loginPageResponse(request, await isOwnerAuthenticated(request, config))
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/session') {
    return noStoreJson({ authenticated: await isOwnerAuthenticated(request, config) })
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    requireSameOrigin(request)
    const contentType = request.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      throw new EdgeHttpError(415, 'Login requires a form-encoded request.')
    }
    const source = await readBoundedText(
      request,
      MAX_LOGIN_BODY_BYTES,
      `Login requests are limited to ${MAX_LOGIN_BODY_BYTES} bytes.`,
    )
    const candidate = new URLSearchParams(source).get('accessKey') ?? ''
    if (!await accessKeysMatch(candidate, config.accessKey)) {
      return loginPageResponse(request, false, 'The access key is not valid.', 401)
    }

    const expiresAt = Math.floor(Date.now() / 1_000) + SESSION_TTL_SECONDS
    const cookie = await createSessionCookie(config, expiresAt, url.protocol === 'https:')
    return new Response(null, {
      status: 303,
      headers: {
        'cache-control': 'no-store',
        location: '/',
        'set-cookie': cookie,
      },
    })
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    requireSameOrigin(request)
    return new Response(null, {
      status: 303,
      headers: {
        'cache-control': 'no-store',
        location: '/login',
        'set-cookie': expiredSessionCookie(url.protocol === 'https:'),
      },
    })
  }

  return undefined
}

/** Validate the opaque, signed owner session carried by an HttpOnly cookie. */
export async function isOwnerAuthenticated(
  request: Request,
  config: OwnerAuthConfig,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<boolean> {
  return await resolveOwnerSession(request, config, nowSeconds) !== undefined
}

/** Validate the owner cookie and expose its bounded lifetime to trusted adapters. */
export async function resolveOwnerSession(
  request: Request,
  config: OwnerAuthConfig,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<OwnerSession | undefined> {
  const secure = new URL(request.url).protocol === 'https:'
  const cookies = readCookies(request.headers.get('cookie'), sessionCookieName(secure))
  if (cookies.length === 0) return undefined

  const key = await importSigningKey(config.accessKey)
  for (const cookie of cookies) {
    const parts = cookie.split('.')
    const version = parts[0]
    const expiresSource = parts[1]
    const signatureSource = parts[2]
    if (parts.length !== 3
      || version !== COOKIE_VERSION
      || expiresSource === undefined
      || signatureSource === undefined
      || !/^\d{10}$/u.test(expiresSource)) {
      continue
    }
    const expiresAt = Number(expiresSource)
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds) continue
    if (expiresAt > nowSeconds + SESSION_TTL_SECONDS) continue

    const signature = decodeBase64Url(signatureSource)
    if (signature === undefined) continue
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      textEncoder.encode(`${SESSION_SIGNING_CONTEXT}${expiresSource}`),
    )
    if (valid) return { expiresAt }
  }
  return undefined
}

/** Redirect unauthenticated document requests to the local login shell. */
export function loginRedirect(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      'cache-control': 'no-store',
      location: '/login',
    },
  })
}

/** Return a credential-safe API rejection. */
export function unauthorizedResponse(): Response {
  const response = noStoreJson({ ok: false, error: 'Owner authentication required.' }, 401)
  response.headers.set('www-authenticate', OWNER_AUTH_CHALLENGE)
  return response
}

async function createSessionCookie(
  config: OwnerAuthConfig,
  expiresAt: number,
  secure: boolean,
): Promise<string> {
  const key = await importSigningKey(config.accessKey)
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(`${SESSION_SIGNING_CONTEXT}${String(expiresAt)}`),
  )
  const value = `${COOKIE_VERSION}.${String(expiresAt)}.${encodeBase64Url(signature)}`
  const expires = new Date(expiresAt * 1_000).toUTCString()
  return `${sessionCookieName(secure)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(SESSION_TTL_SECONDS)}; Expires=${expires}${secure ? '; Secure' : ''}`
}

function expiredSessionCookie(secure: boolean): string {
  return `${sessionCookieName(secure)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`
}

function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_COOKIE_NAME : LOCAL_COOKIE_NAME
}

async function accessKeysMatch(candidate: string, configured: string): Promise<boolean> {
  const candidateBytes = textEncoder.encode(candidate)
  if (candidateBytes.byteLength > MAX_ACCESS_KEY_BYTES) return false
  const [candidateDigest, configuredDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', candidateBytes),
    crypto.subtle.digest('SHA-256', textEncoder.encode(configured)),
  ])
  const left = new Uint8Array(candidateDigest)
  const right = new Uint8Array(configuredDigest)
  let difference = candidateBytes.byteLength < MIN_ACCESS_KEY_BYTES ? 1 : 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

async function importSigningKey(accessKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(accessKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function requireSameOrigin(request: Request): void {
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite === 'same-origin') return
  if (fetchSite !== null) {
    throw new EdgeHttpError(403, 'Cross-origin authentication requests are not allowed.')
  }
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== new URL(request.url).origin) {
    throw new EdgeHttpError(403, 'Cross-origin authentication requests are not allowed.')
  }
}

function readCookies(header: string | null, name: string): string[] {
  if (header === null) return []
  const values: string[] = []
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    if (value.length > 0) values.push(value)
  }
  return values
}

function encodeBase64Url(value: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value: string): ArrayBuffer | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return undefined
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(`${base64}${'='.repeat((4 - base64.length % 4) % 4)}`)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes.buffer
  } catch {
    return undefined
  }
}

function loginPageResponse(request: Request, authenticated: boolean, error?: string, status = 200): Response {
  const body = ownerPage(request, authenticated, DSH_EDGE_UPGRADE_COMMAND, error)
  return new Response(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
}

function noStoreJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  })
}
