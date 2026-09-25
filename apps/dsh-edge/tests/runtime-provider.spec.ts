import { describe, expect, it, vi } from 'vitest'
import { CloudflareContainerBackend } from '@cloudflare/computer/backends/container'
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
vi.mock('@cloudflare/computer/backends/container', () => ({
  CloudflareContainerBackend: class {
    readonly id = 'container-shell'
    constructor(readonly options: unknown) {}
  },
}))
vi.mock('../src/direct-shell.ts', () => ({
  DirectShellBackend: class {
    readonly id = 'worker-shell'
  },
}))

const LOADER = { get: () => undefined, load: () => undefined }
const CONTAINER = { LOADER, DSH_EDGE_CONTAINER_RUNTIME: 'enabled' }
const ctx = { id: { toString: () => 'workspace-id' } } as unknown as DurableObjectState

describe('Edge runtime providers', () => {
  it('offers exactly the provider each deployment build ships', () => {
    expect(availableEdgeRuntimeProviders({}).map(provider => provider.id)).toEqual(['direct'])
    expect(availableEdgeRuntimeProviders({ LOADER }).map(provider => provider.id))
      .toEqual(['dynamic-worker'])
    expect(availableEdgeRuntimeProviders(CONTAINER).map(provider => provider.id))
      .toEqual(['container', 'dynamic-worker'])
  })

  it('offers the container only for the exact deployment marker', () => {
    expect(availableEdgeRuntimeProviders({ LOADER, DSH_EDGE_CONTAINER_RUNTIME: 'true' })
      .map(provider => provider.id)).toEqual(['dynamic-worker'])
  })

  it('keeps the pre-provider shell identity for both builds', () => {
    expect(resolveEdgeRuntimeShell({})).toBe('just-bash-direct')
    expect(resolveEdgeRuntimeShell({ LOADER })).toBe('just-bash-isolated')
    expect(resolveEdgeRuntimeShell(CONTAINER)).toBe('linux-container')
  })

  it('prefers the container for bash and still lets bash select the Dynamic Worker', () => {
    const available = availableEdgeRuntimeProviders(CONTAINER)
    expect(resolveEdgeRuntimeSelection(available))
      .toEqual({ bash: 'container', coding: null, subprocess: null })
    expect(resolveEdgeRuntimeSelection(available, { bash: 'dynamic-worker' }).bash)
      .toBe('dynamic-worker')
  })

  it('defaults bash to the preferred available provider and leaves optional layers unloaded', () => {
    expect(resolveEdgeRuntimeSelection(EDGE_RUNTIME_PROVIDERS)).toEqual({
      bash: 'container',
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
    expect(schema({ bash: 'container' })).toEqual({ bash: 'container' })
    expect(() => schema({ bash: 'sandbox' } as never)).toThrow(/bash/u)
    expect(() => schema({ coding: 'container' })).toThrow(/coding/u)
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

  it('registers the container backend first so default execs reach it', () => {
    const host = { getWorkspaceContainer: () => { throw new Error('unused') } }
    const container = () => host
    const backends = resolveEdgeRuntimeBackends({ env: CONTAINER as never, ctx, container }, {
      bash: 'container',
      coding: 'dynamic-worker',
    })
    // Workspace execs without a backend id use the first registered backend.
    expect(backends).toHaveLength(2)
    expect(backends[0]).toBeInstanceOf(CloudflareContainerBackend)
    expect(backends[1]).toBeInstanceOf(WorkerShellBackend)
    expect((backends[0] as unknown as { options: unknown }).options).toEqual({
      container,
      workspace: { binding: 'DSH_EDGE_INSTANCE', id: 'workspace-id' },
      egress: { mode: 'direct' },
    })
  })

  it('refuses the container provider without a container-enabled Durable Object', () => {
    expect(() => resolveEdgeRuntimeBackends({ env: CONTAINER as never, ctx }))
      .toThrow(/container-enabled Durable Object/u)
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
        artifact: 'direct',
        expectedShell: 'just-bash-direct',
        label: 'Free — Direct Shell',
        hint: 'recommended; runs on Workers Free',
        paid: false,
        providers: ['direct'],
      },
      isolated: {
        environment: 'isolated',
        artifact: 'isolated',
        expectedShell: 'just-bash-isolated',
        label: 'Isolated — Dynamic Worker',
        hint: 'requires Workers Paid (starting at $5/month); adds workflow and run_code',
        paid: true,
        providers: ['dynamic-worker'],
      },
      container: {
        environment: 'container',
        artifact: 'isolated',
        expectedShell: 'linux-container',
        label: 'Container — Linux',
        hint: 'requires Workers Paid; adds a real Linux shell (git, node, python), billed while it runs',
        paid: true,
        providers: ['container', 'dynamic-worker'],
      },
    })
  })

  it('offers Container after the existing runtime choices', () => {
    expect(runtimeModeChoices()).toEqual([
      { value: 'direct', label: 'Free — Direct Shell', hint: 'recommended; runs on Workers Free' },
      {
        value: 'isolated',
        label: 'Isolated — Dynamic Worker',
        hint: 'requires Workers Paid (starting at $5/month); adds workflow and run_code',
      },
      {
        value: 'container',
        label: 'Container — Linux',
        hint: 'requires Workers Paid; adds a real Linux shell (git, node, python), billed while it runs',
      },
    ])
    expect(isRuntimeMode('direct')).toBe(true)
    expect(isRuntimeMode('container')).toBe(true)
    expect(isRuntimeMode('sandbox')).toBe(false)
    expect(isRuntimeMode('toString')).toBe(false)
  })
})
