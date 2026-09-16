/** MCP OAuth 2.1 primitives: discovery, DCR, PKCE, code exchange, token refresh.
 *  All functions are pure (storage-free) — the caller manages persistence. */

const DISCOVERY_TIMEOUT_MS = 10_000

export interface OAuthEndpoints {
  authorization: string
  token: string
  registration?: string | undefined
}

export interface OAuthClient {
  clientId: string
  clientSecret?: string | undefined
}

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string | undefined
  expiresAt?: number | undefined
  tokenType: string
  scope?: string | undefined
}

export interface PendingOAuthFlow {
  state: string
  codeVerifier: string
  redirectUri: string
  serverName: string
  serverUrl: string
  stagedClient?: OAuthClient | undefined
  createdAt: number
}

function randomString(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, length)
}

async function sha256Base64Url(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', encoded)
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
  return base64.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=/gu, '')
}

/** Discover OAuth endpoints from an MCP server's protected resource metadata. */
export async function discoverEndpoints(
  serverUrl: string,
): Promise<OAuthEndpoints> {
  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const url = new URL(serverUrl)

  // RFC 9728: Protected Resource Metadata — path-aware discovery
  const prmPath = url.pathname === '/' ? '/.well-known/oauth-protected-resource' : `/.well-known/oauth-protected-resource${url.pathname}`
  const prmUrl = new URL(prmPath, url.origin)
  const prmRes = await fetch(prmUrl.href, { signal })
  if (!prmRes.ok) throw new Error(`PRM discovery failed: HTTP ${prmRes.status}`)
  const prm = await prmRes.json() as { authorization_servers?: string[] }
  const asUrl = prm.authorization_servers?.[0]
  if (typeof asUrl !== 'string') throw new Error('No authorization server in PRM')

  // RFC 8414: Authorization Server Metadata
  const asMetaUrl = new URL('/.well-known/oauth-authorization-server', new URL(asUrl).origin)
  const asRes = await fetch(asMetaUrl.href, { signal })
  if (!asRes.ok) throw new Error(`AS metadata failed: HTTP ${asRes.status}`)
  const meta = await asRes.json() as {
    authorization_endpoint?: string
    token_endpoint?: string
    registration_endpoint?: string
  }
  if (typeof meta.authorization_endpoint !== 'string' || typeof meta.token_endpoint !== 'string') {
    throw new Error('Missing required endpoints in AS metadata')
  }

  return {
    authorization: meta.authorization_endpoint,
    token: meta.token_endpoint,
    registration: meta.registration_endpoint,
  }
}

/** Dynamic Client Registration (RFC 7591). */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string,
): Promise<OAuthClient> {
  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal,
  })
  if (!res.ok) throw new Error(`DCR failed: HTTP ${res.status}`)
  const data = await res.json() as { client_id?: string; client_secret?: string }
  if (typeof data.client_id !== 'string') throw new Error('DCR response missing client_id')
  return {
    clientId: data.client_id,
    clientSecret: data.client_secret,
  }
}

/** Build PKCE authorization URL. Returns the URL + pending flow state. */
export async function buildAuthorizationUrl(
  endpoints: OAuthEndpoints,
  client: OAuthClient,
  redirectUri: string,
  serverName: string,
  serverUrl: string,
): Promise<{ authorizationUrl: string; pendingFlow: PendingOAuthFlow }> {
  const state = randomString(32)
  const codeVerifier = randomString(64)
  const codeChallenge = await sha256Base64Url(codeVerifier)

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    resource: serverUrl,
  })

  return {
    authorizationUrl: `${endpoints.authorization}?${params.toString()}`,
    pendingFlow: {
      state,
      codeVerifier,
      redirectUri,
      serverName,
      serverUrl,
      stagedClient: client,
      createdAt: Date.now(),
    },
  }
}

/** Exchange authorization code for tokens. */
export async function exchangeCode(
  tokenEndpoint: string,
  client: OAuthClient,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  resource?: string,
): Promise<OAuthTokens> {
  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.clientId,
    code_verifier: codeVerifier,
  })
  if (resource !== undefined) body.set('resource', resource)
  if (client.clientSecret !== undefined) {
    body.set('client_secret', client.clientSecret)
  }
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  })
  if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status}`)
  return parseTokenResponse(await res.json())
}

/** Refresh an access token. */
export async function refreshToken(
  tokenEndpoint: string,
  client: OAuthClient,
  currentRefreshToken: string,
  resource?: string,
): Promise<OAuthTokens> {
  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: currentRefreshToken,
    client_id: client.clientId,
  })
  if (resource !== undefined) body.set('resource', resource)
  if (client.clientSecret !== undefined) {
    body.set('client_secret', client.clientSecret)
  }
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  })
  if (!res.ok) throw new Error(`Token refresh failed: HTTP ${res.status}`)
  return parseTokenResponse(await res.json())
}

function parseTokenResponse(data: unknown): OAuthTokens {
  const d = data as Record<string, unknown>
  if (typeof d.access_token !== 'string') throw new Error('Missing access_token')
  const expiresIn = typeof d.expires_in === 'number' ? d.expires_in : undefined
  return {
    accessToken: d.access_token,
    refreshToken: typeof d.refresh_token === 'string' ? d.refresh_token : undefined,
    expiresAt: expiresIn !== undefined ? Date.now() + expiresIn * 1000 : undefined,
    tokenType: typeof d.token_type === 'string' ? d.token_type : 'Bearer',
    scope: typeof d.scope === 'string' ? d.scope : undefined,
  }
}

/** Check if a token is expired or about to expire (120s skew). */
export function isTokenExpired(tokens: OAuthTokens): boolean {
  if (tokens.expiresAt === undefined) return false
  return Date.now() > tokens.expiresAt - 120_000
}
