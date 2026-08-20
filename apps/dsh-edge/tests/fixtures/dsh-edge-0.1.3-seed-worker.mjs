import { DurableObject } from 'cloudflare:workers'

const OWNER_INSTANCE = 'owner'

export default {
  fetch(request, env) {
    return env.DSH_EDGE_INSTANCE.getByName(OWNER_INSTANCE).fetch(request)
  },
}

/** Seed captured released state without importing any candidate runtime code. */
export class DshEdgeInstance extends DurableObject {
  async fetch(request) {
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    const fixture = await request.json()
    for (const sql of fixture.sql) this.ctx.storage.sql.exec(sql)
    await this.ctx.storage.put(fixture.entries)
    const foreignKeyViolations = this.ctx.storage.sql.exec('PRAGMA foreign_key_check').toArray()
    if (foreignKeyViolations.length > 0) {
      return Response.json({ ok: false, foreignKeyViolations }, { status: 500 })
    }
    return Response.json({ ok: true })
  }
}
