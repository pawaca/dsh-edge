import { describe, expect, it, vi } from 'vitest'
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell'
import { DirectShellBackend } from '../src/direct-shell.ts'
import { resolveEdgeRuntimeBackends } from '../src/runtime-backends.ts'
import {
  EDGE_RUNTIME_PROVIDERS,
  availableEdgeRuntimeProviders,
  edgeRuntimeSettingsSchema,
  resolveEdgeRuntimeSelection,
  resolveEdgeRuntimeShell,
} from '../src/runtime-provider.ts'
import {
  RUNTIME_MODES,
  RUNTIME_PROVIDERS,
  isRuntimeMode,
  runtimeModeChoices,
} from '../scripts/runtime-providers.mjs'

vi.mock('@cloudflare/computer/backends/worker-shell', () => ({
  WorkerShellBackend: class {
    readonly id = 'worker-shell'
    constructor(readonly options: unknown) {}
  },
}))
vi.mock('../src/direct-shell.ts', () => ({
  DirectShellBackend: class {
    readonly id = 'worker-shell'
  },
}))

const LOADER = { get: () => undefined, load: () => undefined }
const ctx = { id: { toString: () => 'workspace-id' } } as unknown as DurableObjectState

describe('Edge runtime providers', () => {
  it('offers exactly the provider each deployment build ships', () => {
    expect(availableEdgeRuntimeProviders({}).map(provider => provider.id)).toEqual(['direct'])
    expect(availableEdgeRuntimeProviders({ LOADER }).map(provider => provider.id))
      .toEqual(['dynamic-worker'])
  })

  it('keeps the pre-provider shell identity for both builds', () => {
    expect(resolveEdgeRuntimeShell({})).toBe('just-bash-direct')
    expect(resolveEdgeRuntimeShell({ LOADER })).toBe('just-bash-isolated')
  })

  it('defaults bash to the preferred available provider and leaves optional layers unloaded', () => {
    expect(resolveEdgeRuntimeSelection(EDGE_RUNTIME_PROVIDERS)).toEqual({
      bash: 'dynamic-worker',
      coding: null,
      subprocess: null,
    })
    expect(resolveEdgeRuntimeSelection(EDGE_RUNTIME_PROVIDERS, { bash: 'direct' }).bash)
      .toBe('direct')
  })

  it('falls back when a stored choice names a provider this deployment lacks', () => {
    const available = availableEdgeRuntimeProviders({})
    expect(resolveEdgeRuntimeSelection(available, {
      bash: 'dynamic-worker',
      coding: 'dynamic-worker',
    })).toEqual({ bash: 'direct', coding: null, subprocess: null })
  })

  it('refuses a deployment with no bash provider', () => {
    expect(() => resolveEdgeRuntimeSelection([])).toThrow(/bash layer/u)
  })

  it('parses an empty or cross-build section but rejects unknown providers', () => {
    const schema = edgeRuntimeSettingsSchema()
    expect(schema({})).toEqual({})
    expect(schema({ bash: 'dynamic-worker', coding: null })).toEqual({
      bash: 'dynamic-worker',
      coding: null,
    })
    expect(() => schema({ bash: 'container' } as never)).toThrow(/bash/u)
    expect(() => schema({ coding: 'direct' })).toThrow(/coding/u)
  })

  it('registers one backend from the selected bash provider', () => {
    const direct = resolveEdgeRuntimeBackends({ env: {}, ctx })
    expect(direct).toHaveLength(1)
    expect(direct[0]).toBeInstanceOf(DirectShellBackend)

    const isolated = resolveEdgeRuntimeBackends({ env: { LOADER: LOADER as never }, ctx })
    expect(isolated).toHaveLength(1)
    expect(isolated[0]).toBeInstanceOf(WorkerShellBackend)
    expect((isolated[0] as unknown as { options: unknown }).options).toEqual({
      loader: LOADER,
      workspace: { binding: 'DSH_EDGE_INSTANCE', id: 'workspace-id' },
      ctx,
    })
  })
})

describe('installer runtime catalog', () => {
  it('mirrors the Worker provider catalog', () => {
    for (const provider of EDGE_RUNTIME_PROVIDERS) {
      expect(RUNTIME_PROVIDERS[provider.id]).toEqual({
        id: provider.id,
        capabilities: [...provider.capabilities],
        plan: provider.plan,
        shell: provider.shell,
      })
    }
    expect(Object.keys(RUNTIME_PROVIDERS).sort())
      .toEqual(EDGE_RUNTIME_PROVIDERS.map(provider => provider.id).sort())
  })

  it('derives each mode from the providers its bindings enable', () => {
    expect(RUNTIME_MODES).toEqual({
      direct: {
        environment: '',
        expectedShell: 'just-bash-direct',
        label: 'Free — Direct Shell',
        hint: 'recommended; runs on Workers Free',
        paid: false,
        providers: ['direct'],
      },
      isolated: {
        environment: 'isolated',
        expectedShell: 'just-bash-isolated',
        label: 'Isolated — Dynamic Worker',
        hint: 'requires Workers Paid (starting at $5/month); adds workflow and run_code',
        paid: true,
        providers: ['dynamic-worker'],
      },
    })
  })

  it('keeps the installer runtime prompt unchanged', () => {
    expect(runtimeModeChoices()).toEqual([
      { value: 'direct', label: 'Free — Direct Shell', hint: 'recommended; runs on Workers Free' },
      {
        value: 'isolated',
        label: 'Isolated — Dynamic Worker',
        hint: 'requires Workers Paid (starting at $5/month); adds workflow and run_code',
      },
    ])
    expect(isRuntimeMode('direct')).toBe(true)
    expect(isRuntimeMode('container')).toBe(false)
    expect(isRuntimeMode('toString')).toBe(false)
  })
})
