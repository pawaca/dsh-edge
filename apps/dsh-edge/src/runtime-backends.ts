/** Construct Computer workspace backends for the selected Edge runtime providers. */

import type { WorkspaceRegisteredBackend } from '@cloudflare/computer'
import {
  WorkerShellBackend,
  type WorkerShellLoader,
} from '@cloudflare/computer/backends/worker-shell'
import { DirectShellBackend } from './direct-shell.ts'
import {
  DIRECT_RUNTIME_PROVIDER,
  DYNAMIC_WORKER_RUNTIME_PROVIDER,
  availableEdgeRuntimeProviders,
  resolveEdgeRuntimeSelection,
  type EdgeRuntimeProviderDescriptor,
  type EdgeRuntimeProviderId,
  type EdgeRuntimeSettings,
} from './runtime-provider.ts'

/** Deployment bindings runtime providers build backends from. */
export interface EdgeRuntimeEnv {
  LOADER?: WorkerShellLoader
}

/** The owning Durable Object facts a backend needs to reach its workspace. */
export interface EdgeRuntimeHost {
  env: EdgeRuntimeEnv
  ctx: DurableObjectState
}

/** A provider descriptor plus the backend factory it contributes to the workspace. */
export interface EdgeRuntimeProvider extends EdgeRuntimeProviderDescriptor {
  backends(host: EdgeRuntimeHost): WorkspaceRegisteredBackend[]
}

const DirectProvider: EdgeRuntimeProvider = {
  ...DIRECT_RUNTIME_PROVIDER,
  backends: () => [new DirectShellBackend()],
}

const DynamicWorkerProvider: EdgeRuntimeProvider = {
  ...DYNAMIC_WORKER_RUNTIME_PROVIDER,
  backends: ({ env, ctx }) => {
    if (env.LOADER === undefined) {
      throw new Error('The dynamic-worker runtime requires the LOADER binding.')
    }
    return [new WorkerShellBackend({
      loader: env.LOADER,
      workspace: {
        binding: 'DSH_EDGE_INSTANCE',
        id: ctx.id.toString(),
      },
      ctx,
    })]
  },
}

const PROVIDERS: Readonly<Record<EdgeRuntimeProviderId, EdgeRuntimeProvider>> = Object.freeze({
  direct: DirectProvider,
  'dynamic-worker': DynamicWorkerProvider,
})

/**
 * Resolve the workspace backends for this deployment: every distinct provider
 * selected for a loaded layer contributes its backends once.
 */
export function resolveEdgeRuntimeBackends(
  host: EdgeRuntimeHost,
  settings?: EdgeRuntimeSettings,
): WorkspaceRegisteredBackend[] {
  const selection = resolveEdgeRuntimeSelection(availableEdgeRuntimeProviders(host.env), settings)
  const selected = new Set<EdgeRuntimeProviderId>()
  for (const id of [selection.bash, selection.coding, selection.subprocess]) {
    if (id !== null) selected.add(id)
  }
  return [...selected].flatMap(id => PROVIDERS[id].backends(host))
}
