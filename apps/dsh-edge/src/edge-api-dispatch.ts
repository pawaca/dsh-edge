/**
 * Local fetch-based RPC dispatch for the Edge API. Replaces the upstream
 * toFetchHandler from the removed dsh-host-apiproxy package. Routes POST
 * /api/<domain>.<method> requests to the corresponding EdgeApi namespace
 * method using the same wire envelope as the old RPC protocol.
 */

import { RpcId, type RpcError } from './edge-rpc-types.ts'
import type { EdgeApi } from './edge-api.ts'

type Handler = (request: never, signal: AbortSignal) => Promise<{ rpcId: unknown; result: unknown }>

const NAMESPACE_ALIASES: Record<string, string> = {
  session: 'sessions',
  skill: 'skills',
  agentPreset: 'agentPresets',
  subagent: 'subagents',
  goal: 'goals',
  event: 'events',
  download: 'downloads',
}

function resolve(api: EdgeApi, key: string): Handler | undefined {
  const dot = key.indexOf('.')
  const slash = key.indexOf('/')
  const sep = dot >= 0 ? dot : slash
  if (sep < 0) return undefined
  const rawNs = key.slice(0, sep)
  const method = key.slice(sep + 1)
  const ns = NAMESPACE_ALIASES[rawNs] ?? rawNs
  const namespace = (api as unknown as Record<string, Record<string, unknown>>)[ns]
  if (namespace === undefined) return undefined
  const fn = namespace[method]
  return typeof fn === 'function' ? fn as Handler : undefined
}

function errorResponse(rpcId: RpcId, error: RpcError): Response {
  return Response.json({ type: 'server-response', rpcId, result: { ok: false, error } })
}

export async function dispatchEdgeApi(api: EdgeApi, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname

  if (request.method !== 'POST' || !path.startsWith('/api/')) {
    return new Response('not found', { status: 404 })
  }

  if (path === '/api/respond') {
    return Response.json({ accepted: false, reason: 'not-pending' })
  }

  const method = path.slice('/api/'.length)
  const handler = resolve(api, method)
  if (handler === undefined) return new Response('not found', { status: 404 })

  let body: Record<string, unknown>
  try { body = await request.json() as Record<string, unknown> } catch {
    return new Response('body is not JSON', { status: 400 })
  }

  const rpcId = typeof body.rpcId === 'string' ? RpcId(body.rpcId) : RpcId('invalid-request')
  const payload = body.payload ?? {}

  try {
    const result = await handler({ rpcId, payload } as never, request.signal)
    return Response.json({ type: 'server-response', rpcId: result.rpcId, result: result.result })
  } catch (error) {
    return errorResponse(rpcId, { code: 'internal', message: String(error), details: {} })
  }
}
