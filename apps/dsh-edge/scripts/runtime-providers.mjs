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
    capabilities: Object.freeze(['bash']),
    plan: 'paid',
    shell: 'linux-container',
  }),
})

const RUNTIME_MODE_DEFINITIONS = Object.freeze({
  direct: {
    environment: '',
    providers: ['direct'],
    label: 'Free — Direct Shell',
    hint: 'recommended; runs on Workers Free',
  },
  isolated: {
    environment: 'isolated',
    providers: ['dynamic-worker'],
    label: 'Isolated — Dynamic Worker',
    hint: 'requires Workers Paid (starting at $5/month); adds workflow and run_code',
  },
})

export const RUNTIME_MODES = Object.freeze(Object.fromEntries(
  Object.entries(RUNTIME_MODE_DEFINITIONS).map(([mode, definition]) => {
    const providers = definition.providers.map(id => RUNTIME_PROVIDERS[id])
    const bash = providers.find(provider => provider.capabilities.includes('bash'))
    if (bash === undefined) throw new Error(`Runtime mode ${mode} has no bash provider.`)
    return [mode, Object.freeze({
      environment: definition.environment,
      expectedShell: bash.shell,
      label: definition.label,
      hint: definition.hint,
      paid: providers.some(provider => provider.plan === 'paid'),
      providers: Object.freeze([...definition.providers]),
    })]
  }),
))

/** The installer's runtime choices, Free modes first. */
export function runtimeModeChoices() {
  return Object.entries(RUNTIME_MODES).map(([value, mode]) => ({
    value,
    label: mode.label,
    hint: mode.hint,
  }))
}

/** Whether `mode` names a deployable runtime mode. */
export function isRuntimeMode(mode) {
  return typeof mode === 'string' && Object.hasOwn(RUNTIME_MODES, mode)
}
