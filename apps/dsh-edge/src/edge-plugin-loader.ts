/** Edge `loader` seam: the read-only entry projection upstream plugin inventory reads. */

import { Context, Service, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import bootGraph from '../standalone/expected-boot-graph.json' with { type: 'json' }

/**
 * The subset of a cordis Loader entry that `PluginInventoryGateway.list()`
 * reads: identity, module name, group marker, effective enablement, and the
 * root fiber whose state maps onto the public phase vocabulary.
 */
export interface EdgeLoaderEntry {
  readonly id: string
  readonly options: { readonly name: string; readonly group?: boolean }
  readonly disabled: boolean
  readonly fiber?: Pick<Fiber, 'state'>
}

/** Entry id prefix for plugins composed in the Durable Object host context. */
export const HOST_ENTRY_PREFIX = 'host:'
/** Entry id prefix for browser plugins served from the reviewed Web boot graph. */
export const WEB_ENTRY_PREFIX = 'web:'

/** Runtime mirror of `FiberState.ACTIVE`; the cordis enum is `const` and cannot be imported at runtime. */
const ACTIVE_FIBER_STATE = 2 as Fiber['state']

declare module '@deepseek-ai/cordis' {
  interface Context {
    loader: EdgeLoader
  }
}

/**
 * Answers `ctx.loader.entries()` for the upstream `dsh-host-plugin-inventory`
 * gateway without a cordis Loader. The Edge composes its host plugins
 * programmatically, so the live plugin registry is the host-side authority;
 * browser plugins are assembled ahead of deployment, so the reviewed boot
 * graph is theirs. Nothing else of the Loader API is provided: the Edge has no
 * config tree to create, update, or remove entries in.
 */
export class EdgeLoader extends Service {
  constructor(ctx: Context) {
    super(ctx, 'loader')
  }

  /** Current non-group entries: named host runtimes first, then the Web boot graph. */
  *entries(): Generator<EdgeLoaderEntry, void, void> {
    const seen = new Map<string, number>()
    for (const [, runtime] of this.ctx.registry.entries()) {
      const name = runtime.name
      if (name === undefined || name === '') continue
      const ordinal = (seen.get(name) ?? 0) + 1
      seen.set(name, ordinal)
      const fiber = rootFiber(runtime)
      yield {
        id: `${HOST_ENTRY_PREFIX}${name}${ordinal === 1 ? '' : `#${String(ordinal)}`}`,
        options: { name },
        disabled: false,
        ...(fiber === undefined ? {} : { fiber }),
      }
    }
    for (const entry of bootGraph) {
      // The static assembly loads every reviewed entry at boot and the client
      // can only reach this Remote once its graph is running, so browser
      // entries report the phase a Loader would give the entry serving them.
      yield {
        id: `${WEB_ENTRY_PREFIX}${entry.id}`,
        options: { name: entry.id },
        disabled: false,
        fiber: { state: ACTIVE_FIBER_STATE },
      }
    }
  }
}

function rootFiber(runtime: Plugin.Runtime): Pick<Fiber, 'state'> | undefined {
  for (const fiber of runtime.fibers) return fiber
  return undefined
}
