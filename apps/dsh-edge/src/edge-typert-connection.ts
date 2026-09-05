/**
 * Edge `connection` seam for the upstream Typert gateway.
 *
 * Upstream Hosts run a Node web server whose `ctx.connection.rpc.intercept()`
 * hands the gateway one dispatch path for every Remote RPC it claims,
 * including the gateway-owned `$events/result` endpoint through which the
 * browser answers a forwarded Agent-scoped waterfall (user questions). A
 * Cloudflare Worker has no upstream web server or connection service, so this
 * seam only captures the interceptor the gateway installs and exposes it to
 * the Durable Object HTTP handler. It owns no protocol: endpoint claims,
 * payload parsing, pending-event correlation, and result envelopes all stay
 * in `@deepseek-ai/dsh-api-gateway`.
 */
import { Context, Service } from '@deepseek-ai/cordis'

/** The RPC interceptor the gateway registers for its `/api` endpoints. */
export interface TypertRpcInterceptor {
  /** Whether the gateway serves this `namespace/method` endpoint. */
  readonly claims: (endpoint: string) => boolean
  /** Dispatch one claimed endpoint; resolves to the upstream `{ ok, value | error }` result. */
  readonly dispatch: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>
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
