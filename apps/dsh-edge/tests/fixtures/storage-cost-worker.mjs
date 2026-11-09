/** Local-only instrumentation around a copied promoted artifact. This file is
 * never bundled or packaged. Counters read workerd's own SQL cursors, including
 * reads performed while consuming a cursor, without retaining result payloads.
 */
import original, { DshEdgeInstance as Instance } from './original.js'

const counts = { sqlCalls: 0, rowsWritten: 0, rowsRead: 0, alarmSet: 0, alarmDelete: 0, alarmGet: 0, kvPut: 0, kvDelete: 0, kvGet: 0, alarms: 0 }
let epoch
const wrapped = new WeakSet()
function instrument(storage) {
  if (wrapped.has(storage)) return
  wrapped.add(storage)
  const exec = storage.sql.exec.bind(storage.sql)
  storage.sql.exec = (...args) => {
    const cursor = exec(...args)
    counts.sqlCalls++
    let read = 0, written = 0
    const record = () => {
      counts.rowsRead += cursor.rowsRead - read
      counts.rowsWritten += cursor.rowsWritten - written
      read = cursor.rowsRead; written = cursor.rowsWritten
    }
    record()
    const wrap = target => new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key, object)
        if (typeof value !== 'function') return value
        return (...parameters) => {
          try {
            const result = value.apply(object, parameters)
            return key === Symbol.iterator || key === 'raw' ? wrap(result) : result
          } finally { record() }
        }
      },
    })
    return wrap(cursor)
  }
  for (const [method, key] of [['setAlarm','alarmSet'],['deleteAlarm','alarmDelete'],['getAlarm','alarmGet'],['put','kvPut'],['delete','kvDelete'],['get','kvGet']]) {
    const invoke = storage[method].bind(storage)
    storage[method] = (...args) => { counts[key]++; return invoke(...args) }
  }
}
export class DshEdgeInstance extends Instance {
  constructor(ctx, env) { instrument(ctx.storage); super(ctx, env) }
  async alarm(...args) { counts.alarms++; return await super.alarm(...args) }
}
export default {
  ...original,
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/api/_local/storage-cost') {
      epoch ??= crypto.randomUUID()
      return Response.json({ epoch, counts })
    }
    return original.fetch(request, env, ctx)
  },
}
