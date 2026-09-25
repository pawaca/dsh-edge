/** Construct Computer workspace backends for the selected Edge runtime providers. */

import type { WorkspaceRegisteredBackend } from '@cloudflare/computer'
import {
  CloudflareContainerBackend,
  type IWorkspaceContainerAPI,
} from '@cloudflare/computer/backends/container'
import {
  WorkerShellBackend,
  type WorkerShellLoader,
} from '@cloudflare/computer/backends/worker-shell'
import { DirectShellBackend } from './direct-shell.ts'
import {
  CONTAINER_RUNTIME_PROVIDER,
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
  DSH_EDGE_CONTAINER_RUNTIME?: string
}

/** The owning Durable Object facts a backend needs to reach its workspace. */
export interface EdgeRuntimeHost {
  env: EdgeRuntimeEnv
  ctx: DurableObjectState
  /** The owning Durable Object's Container handle, present on container-enabled classes. */
  container?: () => { getWorkspaceContainer(): IWorkspaceContainerAPI | Promise<IWorkspaceContainerAPI> }
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

const ContainerProvider: EdgeRuntimeProvider = {
  ...CONTAINER_RUNTIME_PROVIDER,
  backends: ({ ctx, container }) => {
    if (container === undefined) {
      throw new Error('The container runtime requires a container-enabled Durable Object.')
    }
    return [new CloudflareContainerBackend({
      container,
      workspace: {
        binding: 'DSH_EDGE_INSTANCE',
        id: ctx.id.toString(),
      },
      // Package managers and git need the network. The container receives no
      // Edge credentials: none are passed through containerEnv.
      egress: { mode: 'direct' },
    })]
  },
}

const PROVIDERS: Readonly<Record<EdgeRuntimeProviderId, EdgeRuntimeProvider>> = Object.freeze({
  direct: DirectProvider,
  'dynamic-worker': DynamicWorkerProvider,
  container: ContainerProvider,
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
  // The lightweight bash provider registers first, so a command without an
  // explicit backend runs there; the container is reached only by routing.
  const selected = new Set<EdgeRuntimeProviderId>()
  for (const id of [selection.bash, selection.container, selection.coding, selection.subprocess]) {
    if (id !== null) selected.add(id)
  }
  return [...selected].flatMap(id => PROVIDERS[id].backends(host))
}
