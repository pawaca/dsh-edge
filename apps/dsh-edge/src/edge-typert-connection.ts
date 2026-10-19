/**
 * Edge `connection` seam for the upstream Typert gateway.
 *
 * Upstream Hosts run a Node web server whose `ctx.connection.rpc.intercept()`
 * hands the gateway one dispatch path for every Remote RPC it claims,
 * including the gateway-owned `$events/result` endpoint through which the
 * browser answers a forwarded Agent-scoped waterfall (user questions). A
 * Cloudflare Worker has no upstream web server or connection service, so this
 * seam only captures the interceptor the gateway installs and exposes it to
 * the Durable Object HTTP handler. Endpoint claims, payload parsing,
 * pending-event correlation, and result encoding stay in
 * `@deepseek-ai/dsh-api-gateway`; {@link typertRpcResponse} frames the
 * encoded result on HTTP as the upstream Connection does.
 *
 * The gateway serves every call and stream on behalf of a Peer. The Durable
 * Object authenticates the single owner before a request reaches this seam, so
 * the seam holds the one owner Peer upstream's connection gives every
 * authenticated browser, and binds it into each dispatch.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'

/** One encoded gateway result: byte values leave `null` placeholders and travel beside the JSON. */
export type TypertRpcResult =
  | {
    readonly ok: true
    readonly value: unknown
    readonly attachments?: readonly { readonly path: readonly (string | number)[]; readonly bytes: Uint8Array }[]
  }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

/** The RPC interceptor the gateway registers for its `/api` endpoints, as the gateway dispatches. */
export interface GatewayRpcInterceptor {
  /** Whether the gateway serves this `namespace/method` endpoint. */
  readonly claims: (endpoint: string) => boolean
  /** Dispatch one claimed endpoint for a Peer; resolves to the upstream encoded result. */
  readonly dispatch: (endpoint: string, payload: unknown, signal: AbortSignal, peer: PeerScope) => Promise<TypertRpcResult>
}

/** The same interceptor with the owner Peer bound in: what the Durable Object's request handler calls. */
export interface TypertRpcInterceptor {
  readonly claims: GatewayRpcInterceptor['claims']
  /** Dispatch one claimed endpoint for the owner; resolves to the upstream encoded result. */
  readonly dispatch: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<TypertRpcResult>
}

/**
 * Frame one gateway result as the upstream Connection does: plain JSON, or
 * `multipart/form-data` with a `metadata` envelope and one part per byte value.
 */
export function typertRpcResponse(rpcId: string, result: TypertRpcResult): Response {
  if (!result.ok) return Response.json({ type: 'server-response', rpcId, result })
  const { attachments, ...success } = result
  const body = { type: 'server-response', rpcId, result: success }
  if (attachments === undefined || attachments.length === 0) return Response.json(body)
  const parts = new FormData()
  const metadata = attachments.map((attachment, index) => {
    const part = `bytes-${String(index)}`
    parts.set(part, new Blob([new Uint8Array(attachment.bytes)]))
    return { path: [...attachment.path], codec: 'bytes', part }
  })
  parts.set('metadata', JSON.stringify({ ...body, attachments: metadata }))
  return new Response(parts)
}

/** One HTTP route an upstream plugin registers on the connection (`connection.fetch.register`). */
export interface EdgeFetchRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody?: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** Minimal `ctx.connection` surface consumed by the upstream gateway on Workers. */
export class EdgeTypertConnection extends Service {
  private interceptor: TypertRpcInterceptor | undefined
  /** The owner Peer every authenticated request and stream shares; it lives as long as this seam. */
  readonly peer: Peer
  private readonly routes = new Map<string, EdgeFetchRoute>()

  /**
   * Upstream plugins that serve plain HTTP (the session log download) register
   * a route here; the Durable Object's request handler dispatches it, since a
   * Worker has no upstream web server to mount it on.
   */
  readonly fetch = {
    register: (route: EdgeFetchRoute): (() => void) => {
      if (this.routes.has(route.path)) throw new Error(`dsh-edge: a fetch route is already registered at ${JSON.stringify(route.path)}`)
      this.routes.set(route.path, route)
      return () => {
        if (this.routes.get(route.path) === route) this.routes.delete(route.path)
      }
    },
  }

  readonly rpc = {
    intercept: (
      path: string,
      claims: GatewayRpcInterceptor['claims'],
      dispatch: GatewayRpcInterceptor['dispatch'],
    ): (() => void) => {
      if (path !== '/api') throw new Error(`dsh-edge: unsupported RPC interceptor path ${JSON.stringify(path)}`)
      if (this.interceptor !== undefined) throw new Error('dsh-edge: a Typert RPC interceptor is already registered')
      const interceptor: TypertRpcInterceptor = {
        claims,
        dispatch: (endpoint, payload, signal) => dispatch(endpoint, payload, signal, this.peer),
      }
      this.interceptor = interceptor
      return () => {
        if (this.interceptor === interceptor) this.interceptor = undefined
      }
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'connection')
    this.peer = new Peer(ctx, { principal: { kind: 'owner' } })
  }

  /** The handler registered for this path that serves this method, if any. */
  route(path: string, method: string): EdgeFetchRoute['fetch'] | undefined {
    const route = this.routes.get(path)
    return route?.methods.includes(method) === true ? route.fetch : undefined
  }

  /** The interceptor currently registered by the gateway, if it has activated. */
  current(): TypertRpcInterceptor | undefined {
    return this.interceptor
  }
}
