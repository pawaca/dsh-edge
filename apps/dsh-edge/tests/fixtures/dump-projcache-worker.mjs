import { DurableObject } from 'cloudflare:workers'

const OWNER_INSTANCE = 'owner'

export default {
  fetch(request, env) {
    return env.DSH_EDGE_INSTANCE.getByName(OWNER_INSTANCE).fetch(request)
  },
}

/** Read the projection-cache KV medium a released dsh-edge wrote, without importing any candidate runtime code. */
export class DshEdgeInstance extends DurableObject {
  async fetch() {
    const entries = await this.ctx.storage.list({ prefix: 'dsh-kv:session_projcache:' })
    return Response.json({ entries: Object.fromEntries(entries) })
  }
}
