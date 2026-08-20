/** Minimal generated-Remote compatibility required by the upstream Web UI. */

import type { ServerResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import { clientRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'

const COMMAND_LIST_PATH = '/api/commands/list'

/**
 * Handle Edge-owned endpoints on upstream's shared generic `/api` channel.
 * The Edge preset currently registers no slash commands, so its truthful
 * catalog is empty; retaining the upstream carrier envelope lets ui-commands
 * stay mounted without a parallel Edge-only client implementation.
 */
export async function handleEdgeRemote(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url)
  if (url.pathname !== COMMAND_LIST_PATH) return undefined
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
  }
  if (request.headers.get('content-type')?.split(';', 1).at(0)?.trim() !== 'application/json') {
    return new Response('expected application/json', { status: 415 })
  }

  let wire: unknown
  try {
    wire = await request.json()
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }
  const parsed = clientRequestSchema.safeParse(wire)
  if (!parsed.success || parsed.data.method !== 'commands/list') {
    return new Response('request path and method do not match', { status: 400 })
  }

  const body: ServerResponse = {
    type: 'server-response',
    rpcId: parsed.data.rpcId,
    result: { ok: true, value: [] },
  }
  return Response.json(body)
}
