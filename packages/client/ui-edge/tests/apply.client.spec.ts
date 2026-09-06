import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { EdgeSettingsSection } from '../src/client/EdgeSettingsSection.tsx'

describe('ui-edge apply', () => {
  it('registers the settings section and leaves the directory flow to the upstream browse picker', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope'])
    const entries: Array<{
      options: Record<string, unknown> & { inject?: () => unknown }
      component: unknown
    }> = []
    const registerLocale = vi.fn()
    const mirror = { persistence: 'memory', load: vi.fn() }
    const ctx = {
      workspaces: { openPath: vi.fn() },
      settingsScope: { describe: () => mirror },
      inject: (_deps: string[], callback: (injected: unknown) => unknown) => callback(ctx),
      effect: (callback: () => unknown) => callback(),
      locale: {
        register: registerLocale,
        bind: () => (key: string) => key === 'nav' ? 'DSH Edge' : key,
      },
      slots: {
        inject: (_name: string, callback: () => unknown) => {
          const result = callback()
          if (result && typeof result === 'object' && Symbol.iterator in result) {
            for (const _ of result as Iterable<unknown>) { /* exhaust generator */ }
          }
        },
        register: (options: Record<string, unknown>, component: unknown) => {
          entries.push({ options, component })
          return () => {}
        },
      },
    }
    apply(ctx as never)
    expect(mirror.persistence).toBe('host')
    expect(mirror.load).toHaveBeenCalledOnce()
    expect(registerLocale).toHaveBeenCalledOnce()

    const settingsEntry = entries.find(e => e.component === EdgeSettingsSection)
    expect(settingsEntry).toBeDefined()
    if (settingsEntry === undefined) throw new Error('Edge settings slot was not registered')
    expect(settingsEntry.options).toMatchObject({ id: 'dsh-edge', order: 90 })
    expect((settingsEntry.options.label as () => string)()).toBe('DSH Edge')
    const injected = settingsEntry.options.inject?.() as import('../src/client/EdgeSettingsSection.tsx').EdgeSettingsInjected
    expect(injected.hooks.edgeSettings.getSnapshot().status).toBe('idle')
    expect(typeof injected.load).toBe('function')
    expect(typeof injected.copyUpgrade).toBe('function')

    // The upstream browse picker face fills both `directoryFlow` holes; a second
    // occupant of a `single` hole would fail the composition loud.
    const flowNames = entries.map(e => e.options.name).filter(name => String(name).endsWith('directoryFlow'))
    expect(flowNames).toEqual([])
  })
})
