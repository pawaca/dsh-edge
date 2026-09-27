import { describe, expect, it, vi } from 'vitest'
import { CloudflareContainerBackend } from '@cloudflare/computer/backends/container'
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell'
import { DirectShellBackend } from '../src/direct-shell.ts'
import { resolveEdgeRuntimeBackends } from '../src/runtime-backends.ts'
import {
  EDGE_RUNTIME_PROVIDERS,
  availableEdgeRuntimeProviders,
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

  it('keeps bash in the lightweight shell and loads the container beside it', () => {
    expect(resolveEdgeRuntimeSelection(availableEdgeRuntimeProviders(CONTAINER)))
      .toEqual({ bash: 'dynamic-worker', container: 'container' })
    expect(resolveEdgeRuntimeSelection(availableEdgeRuntimeProviders({ LOADER })))
      .toEqual({ bash: 'dynamic-worker', container: null })
    expect(resolveEdgeRuntimeSelection(availableEdgeRuntimeProviders({})))
      .toEqual({ bash: 'direct', container: null })
  })

  it('refuses a deployment with no bash provider', () => {
    expect(() => resolveEdgeRuntimeSelection([])).toThrow(/bash layer/u)
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

  it('registers the lightweight shell first and the container second', () => {
    const host = { getWorkspaceContainer: () => { throw new Error('unused') } }
    const container = () => host
    const backends = resolveEdgeRuntimeBackends({ env: CONTAINER as never, ctx, container })
    // Workspace execs without a backend id use the first registered backend,
    // so only routing reaches the container.
    expect(backends.map(backend => (backend as { id: string }).id)).toEqual(['worker-shell', 'container-shell'])
    expect(backends[0]).toBeInstanceOf(WorkerShellBackend)
    expect(backends[1]).toBeInstanceOf(CloudflareContainerBackend)
    expect((backends[1] as unknown as { options: unknown }).options).toEqual({
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
        label: 'Free',
        hint: 'recommended; runs on Workers Free with a lightweight shell',
        paid: false,
        providers: ['direct'],
      },
      isolated: {
        environment: 'isolated',
        artifact: 'isolated',
        expectedShell: 'just-bash-isolated',
        label: 'Paid',
        hint: 'requires Workers Paid (starting at $5/month); isolated shell plus run_code and workflow',
        paid: true,
        providers: ['dynamic-worker'],
      },
      container: {
        environment: 'container',
        artifact: 'isolated',
        expectedShell: 'linux-container',
        label: 'Paid + Linux container',
        hint: 'Paid plus a Linux container for git, node, and python, used only when a command needs it; billed while it runs',
        paid: true,
        providers: ['container', 'dynamic-worker'],
      },
    })
  })

  it('offers three tiers: Free, Paid, and Paid with a Linux container', () => {
    expect(runtimeModeChoices()).toEqual([
      { value: 'direct', label: 'Free', hint: 'recommended; runs on Workers Free with a lightweight shell' },
      {
        value: 'isolated',
        label: 'Paid',
        hint: 'requires Workers Paid (starting at $5/month); isolated shell plus run_code and workflow',
      },
      {
        value: 'container',
        label: 'Paid + Linux container',
        hint: 'Paid plus a Linux container for git, node, and python, used only when a command needs it; billed while it runs',
      },
    ])
    expect(isRuntimeMode('direct')).toBe(true)
    expect(isRuntimeMode('container')).toBe(true)
    expect(isRuntimeMode('sandbox')).toBe(false)
    expect(isRuntimeMode('toString')).toBe(false)
  })
})
