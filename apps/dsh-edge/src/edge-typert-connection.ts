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
 */
import { Context, Service } from '@deepseek-ai/cordis'

/** One encoded gateway result: byte values leave `null` placeholders and travel beside the JSON. */
export type TypertRpcResult =
  | {
    readonly ok: true
    readonly value: unknown
    readonly attachments?: readonly { readonly path: readonly (string | number)[]; readonly bytes: Uint8Array }[]
  }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

/** The RPC interceptor the gateway registers for its `/api` endpoints. */
export interface TypertRpcInterceptor {
  /** Whether the gateway serves this `namespace/method` endpoint. */
  readonly claims: (endpoint: string) => boolean
  /** Dispatch one claimed endpoint; resolves to the upstream encoded result. */
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

/** Minimal `ctx.connection` surface consumed by the upstream gateway on Workers. */
export class EdgeTypertConnection extends Service {
  private interceptor: TypertRpcInterceptor | undefined

  readonly rpc = {
    intercept: (
      path: string,
      claims: TypertRpcInterceptor['claims'],
      dispatch: TypertRpcInterceptor['dispatch'],
    ): (() => void) => {
      if (path !== '/api') throw new Error(`dsh-edge: unsupported RPC interceptor path ${JSON.stringify(path)}`)
      if (this.interceptor !== undefined) throw new Error('dsh-edge: a Typert RPC interceptor is already registered')
      const interceptor: TypertRpcInterceptor = { claims, dispatch }
      this.interceptor = interceptor
      return () => {
        if (this.interceptor === interceptor) this.interceptor = undefined
      }
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  /** The interceptor currently registered by the gateway, if it has activated. */
  current(): TypertRpcInterceptor | undefined {
    return this.interceptor
  }
}
