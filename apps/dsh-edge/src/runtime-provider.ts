/**
 * Edge runtime provider catalog: which execution runtimes a deployment offers,
 * which capability layers each one serves, and how a per-layer selection
 * resolves against the providers a deployment's bindings actually make
 * available. Pure data and resolution only; backend construction lives in
 * `runtime-backends.ts` so the entry Worker can project runtime facts without
 * importing shell implementations.
 */

import Schema from '@deepseek-ai/schemastery'

/** One independently selectable runtime layer. */
export type EdgeRuntimeCapability = 'bash' | 'coding' | 'subprocess'

/** Stable identifier of one runtime provider. */
export type EdgeRuntimeProviderId = 'direct' | 'dynamic-worker'

/** Whether a provider can serve this deployment. */
export type EdgeRuntimeProviderStatus = 'available' | 'needs-binding'

/** The deployment bindings a provider probe may inspect. */
export interface EdgeRuntimeProbeSource {
  LOADER?: unknown
}

/** Secret-free description of one runtime provider. */
export interface EdgeRuntimeProviderDescriptor {
  readonly id: EdgeRuntimeProviderId
  readonly capabilities: readonly EdgeRuntimeCapability[]
  /** The minimum Cloudflare Workers plan whose bindings the provider needs. */
  readonly plan: 'free' | 'paid'
  /** The public shell identity projected when this provider serves `bash`. */
  readonly shell: 'just-bash-direct' | 'just-bash-isolated'
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

/** Every known provider in default-preference order (first available wins). */
export const EDGE_RUNTIME_PROVIDERS: readonly EdgeRuntimeProviderDescriptor[] = Object.freeze([
  DYNAMIC_WORKER_RUNTIME_PROVIDER,
  DIRECT_RUNTIME_PROVIDER,
])

/** Per-layer provider choice; `null` leaves the layer unloaded. `bash` is always loaded. */
export interface EdgeRuntimeSelection {
  bash: EdgeRuntimeProviderId
  coding: EdgeRuntimeProviderId | null
  subprocess: EdgeRuntimeProviderId | null
}

/** The persisted settings shape; a stored id may name a provider this build lacks. */
export type EdgeRuntimeSettings = {
  [Layer in keyof EdgeRuntimeSelection]?: EdgeRuntimeProviderId | null
}

export const RUNTIME_SETTINGS_NAMESPACE = 'edge-runtime'

/** List the providers this deployment's bindings make available, in preference order. */
export function availableEdgeRuntimeProviders(
  source: EdgeRuntimeProbeSource,
  providers: readonly EdgeRuntimeProviderDescriptor[] = EDGE_RUNTIME_PROVIDERS,
): EdgeRuntimeProviderDescriptor[] {
  return providers.filter(provider => provider.probe(source) === 'available')
}

/**
 * Resolve the effective provider per layer. A stored choice applies only when
 * that provider is available and serves the layer; otherwise `bash` falls back
 * to the first available bash provider and optional layers stay unloaded, so a
 * redeploy that removes a binding never strands a Durable Object.
 */
export function resolveEdgeRuntimeSelection(
  available: readonly EdgeRuntimeProviderDescriptor[],
  settings: EdgeRuntimeSettings = {},
): EdgeRuntimeSelection {
  const serves = (layer: EdgeRuntimeCapability, id: EdgeRuntimeProviderId | null | undefined) =>
    available.find(provider => provider.id === id && provider.capabilities.includes(layer))
  const bash = serves('bash', settings.bash)
    ?? available.find(provider => provider.capabilities.includes('bash'))
  if (bash === undefined) {
    throw new Error('No available runtime provider serves the bash layer.')
  }
  return {
    bash: bash.id,
    coding: serves('coding', settings.coding)?.id ?? null,
    subprocess: serves('subprocess', settings.subprocess)?.id ?? null,
  }
}

/** Resolve the public shell identity for a deployment's default bash provider. */
export function resolveEdgeRuntimeShell(
  source: EdgeRuntimeProbeSource,
): EdgeRuntimeProviderDescriptor['shell'] {
  const available = availableEdgeRuntimeProviders(source)
  const { bash } = resolveEdgeRuntimeSelection(available)
  return available.find(provider => provider.id === bash)!.shell
}

/**
 * Settings schema for the `edge-runtime` namespace. Each layer accepts any
 * known provider that serves it (or `null` for optional layers) so a value
 * written under a different build still parses at startup; availability is
 * applied later by {@link resolveEdgeRuntimeSelection}.
 */
export function edgeRuntimeSettingsSchema(
  providers: readonly EdgeRuntimeProviderDescriptor[] = EDGE_RUNTIME_PROVIDERS,
): Schema<EdgeRuntimeSettings> {
  const layer = (capability: EdgeRuntimeCapability, optional: boolean) => {
    const ids = providers
      .filter(provider => provider.capabilities.includes(capability))
      .map(provider => Schema.const(provider.id))
    return Schema.union(optional ? [...ids, Schema.const(null)] : ids)
  }
  return Schema.object({
    bash: layer('bash', false),
    coding: layer('coding', true),
    subprocess: layer('subprocess', true),
  }) as unknown as Schema<EdgeRuntimeSettings>
}
