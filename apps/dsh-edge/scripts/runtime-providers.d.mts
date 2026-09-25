export type RuntimeMode = 'direct' | 'isolated' | 'container'
export type RuntimeProviderId = 'direct' | 'dynamic-worker' | 'container'
export type RuntimeCapability = 'bash' | 'coding' | 'subprocess'

export const RUNTIME_PROVIDERS: Readonly<Record<RuntimeProviderId, Readonly<{
  id: RuntimeProviderId
  capabilities: readonly RuntimeCapability[]
  plan: 'free' | 'paid'
  shell: 'just-bash-direct' | 'just-bash-isolated' | 'linux-container'
}>>>
export const RUNTIME_MODES: Readonly<Record<RuntimeMode, Readonly<{
  environment: string
  /** The released Worker artifact this mode deploys; it names the deployment id. */
  artifact: 'direct' | 'isolated'
  expectedShell: 'just-bash-direct' | 'just-bash-isolated' | 'linux-container'
  label: string
  hint: string
  paid: boolean
  providers: readonly RuntimeProviderId[]
}>>>
export function runtimeModeChoices(): Array<{ value: RuntimeMode; label: string; hint: string }>
export function isRuntimeMode(mode: unknown): mode is RuntimeMode
