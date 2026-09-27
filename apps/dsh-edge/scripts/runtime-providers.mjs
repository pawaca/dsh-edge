/**
 * Installer runtime catalog. Providers mirror the Worker's
 * `src/runtime-provider.ts` catalog; a runtime mode is one deployable wrangler
 * environment whose bindings enable a set of providers. Plan gating, labels,
 * and the expected public shell all derive from the providers a mode enables.
 */

export const RUNTIME_PROVIDERS = Object.freeze({
  direct: Object.freeze({
    id: 'direct',
    capabilities: Object.freeze(['bash']),
    plan: 'free',
    shell: 'just-bash-direct',
  }),
  'dynamic-worker': Object.freeze({
    id: 'dynamic-worker',
    capabilities: Object.freeze(['bash', 'coding']),
    plan: 'paid',
    shell: 'just-bash-isolated',
  }),
  container: Object.freeze({
    id: 'container',
    capabilities: Object.freeze(['container']),
    plan: 'paid',
    shell: 'linux-container',
  }),
})

// Modes are listed in capability order: each one can do everything the modes
// before it can, so the installer presents them as cumulative choices.
const RUNTIME_MODE_DEFINITIONS = Object.freeze({
  direct: {
    environment: '',
    artifact: 'direct',
    providers: ['direct'],
    label: 'Research and write',
    hint: 'search the web, read pages, draft docs, connect your tools (MCP) · Free',
    capability: 'research and write',
    cost: 'free on Workers Free',
  },
  isolated: {
    environment: 'isolated',
    artifact: 'isolated',
    providers: ['dynamic-worker'],
    label: '+ Analyze data and split big jobs',
    hint: 'runs scripts on your data; hands parts of a big task to parallel agents · Workers Paid ($5/mo)',
    capability: 'analyze data and split big jobs',
    cost: 'requires Workers Paid on this account (from $5/month)',
  },
  // The Container mode deploys the isolated Worker; the first bash-capable
  // provider sets the shell identity, so the container comes first.
  container: {
    environment: 'container',
    artifact: 'isolated',
    providers: ['container', 'dynamic-worker'],
    label: '+ Work on code projects',
    hint: 'clone repos, install packages, run tests (git, npm, python) · Workers Paid + container time',
    capability: 'work on code projects',
    cost: 'requires Workers Paid on this account (from $5/month), plus container time while it runs',
  },
})
const MODE_ORDER = Object.freeze(Object.keys(RUNTIME_MODE_DEFINITIONS))

export const RUNTIME_MODES = Object.freeze(Object.fromEntries(
  Object.entries(RUNTIME_MODE_DEFINITIONS).map(([mode, definition]) => {
    const providers = definition.providers.map(id => RUNTIME_PROVIDERS[id])
    const bash = providers.find(provider => provider.capabilities.includes('bash'))
    if (bash === undefined) throw new Error(`Runtime mode ${mode} has no bash provider.`)
    // A mode with a container reports the container identity; commands still
    // start in its lightweight bash provider.
    const identity = providers.find(provider => provider.capabilities.includes('container')) ?? bash
    return [mode, Object.freeze({
      environment: definition.environment,
      artifact: definition.artifact,
      expectedShell: identity.shell,
      label: definition.label,
      hint: definition.hint,
      capability: definition.capability,
      cost: definition.cost,
      paid: providers.some(provider => provider.plan === 'paid'),
      providers: Object.freeze([...definition.providers]),
    })]
  }),
))

/** The installer's capability choices, in cumulative order. */
export function runtimeModeChoices() {
  return MODE_ORDER.map(value => ({
    value,
    label: RUNTIME_MODES[value].label,
    hint: RUNTIME_MODES[value].hint,
  }))
}

/** Everything an instance in `mode` can do, including what the modes before it do. */
export function modeCapabilities(mode) {
  if (!isRuntimeMode(mode)) throw new Error(`Unsupported runtime mode: ${String(mode)}`)
  return MODE_ORDER.slice(0, MODE_ORDER.indexOf(mode) + 1)
    .map(value => RUNTIME_MODES[value].capability)
}

/** What moving an instance from `from` to `to` takes away. */
export function lostCapabilities(from, to) {
  const kept = new Set(modeCapabilities(to))
  return modeCapabilities(from).filter(capability => !kept.has(capability))
}

/** Whether `mode` names a deployable runtime mode. */
export function isRuntimeMode(mode) {
  return typeof mode === 'string' && Object.hasOwn(RUNTIME_MODES, mode)
}
