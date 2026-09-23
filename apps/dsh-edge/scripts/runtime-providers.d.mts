export type RuntimeMode = 'direct' | 'isolated'
export type RuntimeProviderId = 'direct' | 'dynamic-worker'
export type RuntimeCapability = 'bash' | 'coding' | 'subprocess'

export const RUNTIME_PROVIDERS: Readonly<Record<RuntimeProviderId, Readonly<{
  id: RuntimeProviderId
  capabilities: readonly RuntimeCapability[]
  plan: 'free' | 'paid'
  shell: 'just-bash-direct' | 'just-bash-isolated'
}>>>
export const RUNTIME_MODES: Readonly<Record<RuntimeMode, Readonly<{
  environment: string
  expectedShell: 'just-bash-direct' | 'just-bash-isolated'
  label: string
  hint: string
  paid: boolean
  providers: readonly RuntimeProviderId[]
}>>>
export function runtimeModeChoices(): Array<{ value: RuntimeMode; label: string; hint: string }>
export function isRuntimeMode(mode: unknown): mode is RuntimeMode
