/**
 * Edge runtime provider catalog: which execution runtimes a deployment offers,
 * which capability layers each one serves, and which provider serves each
 * layer given the bindings a deployment actually has. Pure data and resolution only; backend construction lives in
 * `runtime-backends.ts` so the entry Worker can project runtime facts without
 * importing shell implementations.
 */

/**
 * One runtime capability layer. `bash` is the lightweight shell
 * every command starts in; `container` is the Linux shell that commands
 * needing git, node, python, or the network are routed to.
 */
export type EdgeRuntimeCapability = 'bash' | 'container' | 'coding' | 'subprocess'

/** Stable identifier of one runtime provider. */
export type EdgeRuntimeProviderId = 'direct' | 'dynamic-worker' | 'container'

/** Whether a provider can serve this deployment. */
export type EdgeRuntimeProviderStatus = 'available' | 'needs-binding'

/** The deployment bindings a provider probe may inspect. */
export interface EdgeRuntimeProbeSource {
  LOADER?: unknown
  /**
   * Declares that the owning Durable Object class has a Container attached.
   * Containers attach to the class rather than to a binding, so the entry
   * Worker cannot observe them; the Durable Object verifies this marker
   * against `ctx.container` when it starts.
   */
  DSH_EDGE_CONTAINER_RUNTIME?: string
}

/** The `DSH_EDGE_CONTAINER_RUNTIME` value a Container deployment declares. */
export const CONTAINER_RUNTIME_MARKER = 'enabled'

/** Secret-free description of one runtime provider. */
export interface EdgeRuntimeProviderDescriptor {
  readonly id: EdgeRuntimeProviderId
  readonly capabilities: readonly EdgeRuntimeCapability[]
  /** The minimum Cloudflare Workers plan whose bindings the provider needs. */
  readonly plan: 'free' | 'paid'
  /** The public shell identity projected when this provider serves `bash`. */
  readonly shell: 'just-bash-direct' | 'just-bash-isolated' | 'linux-container'
  probe(source: EdgeRuntimeProbeSource): EdgeRuntimeProviderStatus
}

/**
 * In-process just-bash inside the owning Durable Object. The isolated build
 * replaces this shell with a fail-closed stub and always carries a Loader
 * binding, so a Loader binding means the Direct shell is not bundled.
 */
export const DIRECT_RUNTIME_PROVIDER = Object.freeze<EdgeRuntimeProviderDescriptor>({
  id: 'direct',
  capabilities: Object.freeze<EdgeRuntimeCapability[]>(['bash']),
  plan: 'free',
  shell: 'just-bash-direct',
  probe: source => source.LOADER === undefined ? 'available' : 'needs-binding',
})

/** just-bash dispatched into a Dynamic Worker through the Worker Loader binding. */
export const DYNAMIC_WORKER_RUNTIME_PROVIDER = Object.freeze<EdgeRuntimeProviderDescriptor>({
  id: 'dynamic-worker',
  // coding: `run_code` runs each program in its own Dynamic Worker.
  capabilities: Object.freeze<EdgeRuntimeCapability[]>(['bash', 'coding']),
  plan: 'paid',
  shell: 'just-bash-isolated',
  probe: source => source.LOADER === undefined ? 'needs-binding' : 'available',
})

/** A Linux Container attached to the owning Durable Object, operated through computerd. */
export const CONTAINER_RUNTIME_PROVIDER = Object.freeze<EdgeRuntimeProviderDescriptor>({
  id: 'container',
  capabilities: Object.freeze<EdgeRuntimeCapability[]>(['container']),
  plan: 'paid',
  shell: 'linux-container',
  probe: source => source.DSH_EDGE_CONTAINER_RUNTIME === CONTAINER_RUNTIME_MARKER
    ? 'available'
    : 'needs-binding',
})

/** Every known provider in default-preference order (first available wins). */
export const EDGE_RUNTIME_PROVIDERS: readonly EdgeRuntimeProviderDescriptor[] = Object.freeze([
  CONTAINER_RUNTIME_PROVIDER,
  DYNAMIC_WORKER_RUNTIME_PROVIDER,
  DIRECT_RUNTIME_PROVIDER,
])

/**
 * The providers serving each layer, derived from the deployment's bindings
 * alone: `bash` is the lightweight shell every command starts in, and
 * `container` is loaded beside it whenever the deployment has one.
 */
export interface EdgeRuntimeSelection {
  bash: EdgeRuntimeProviderId
  container: EdgeRuntimeProviderId | null
}

/** List the providers this deployment's bindings make available, in preference order. */
export function availableEdgeRuntimeProviders(
  source: EdgeRuntimeProbeSource,
  providers: readonly EdgeRuntimeProviderDescriptor[] = EDGE_RUNTIME_PROVIDERS,
): EdgeRuntimeProviderDescriptor[] {
  return providers.filter(provider => provider.probe(source) === 'available')
}

/** Resolve the first available provider for each layer. */
export function resolveEdgeRuntimeSelection(
  available: readonly EdgeRuntimeProviderDescriptor[],
): EdgeRuntimeSelection {
  const first = (layer: EdgeRuntimeCapability) =>
    available.find(provider => provider.capabilities.includes(layer))
  const bash = first('bash')
  if (bash === undefined) {
    throw new Error('No available runtime provider serves the bash layer.')
  }
  return { bash: bash.id, container: first('container')?.id ?? null }
}

/**
 * Resolve the public shell identity: `linux-container` when the deployment
 * routes commands to a container, otherwise its lightweight shell.
 */
export function resolveEdgeRuntimeShell(
  source: EdgeRuntimeProbeSource,
): EdgeRuntimeProviderDescriptor['shell'] {
  const available = availableEdgeRuntimeProviders(source)
  const { bash, container } = resolveEdgeRuntimeSelection(available)
  return available.find(provider => provider.id === (container ?? bash))!.shell
}
