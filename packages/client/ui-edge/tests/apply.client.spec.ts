import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { EdgeSettingsSection } from '../src/client/EdgeSettingsSection.tsx'

describe('ui-edge apply', () => {
  it('registers one localized Edge section through the standard settings slot', () => {
    expect(inject).toEqual(['slots', 'locale'])
    let entry: {
      options: Record<string, unknown> & { inject?: () => unknown }
      component: unknown
    } | undefined
    const registerLocale = vi.fn()
    const ctx = {
      effect: (callback: () => unknown) => callback(),
      locale: {
        register: registerLocale,
        bind: () => (key: string) => key === 'nav' ? 'DSH Edge' : key,
      },
      slots: {
        inject: (_name: string, callback: () => unknown) => callback(),
        register: (options: Record<string, unknown>, component: unknown) => {
          entry = { options, component }
          return () => {}
        },
      },
    }
    apply(ctx as never)
    expect(registerLocale).toHaveBeenCalledOnce()
    expect(entry).toBeDefined()
    if (entry === undefined) throw new Error('Edge settings slot was not registered')
    expect(entry.component).toBe(EdgeSettingsSection)
    expect(entry.options).toMatchObject({ id: 'dsh-edge', order: 90 })
    expect((entry.options.label as () => string)()).toBe('DSH Edge')
    const injected = entry.options.inject?.() as import('../src/client/EdgeSettingsSection.tsx').EdgeSettingsInjected
    expect(injected.hooks.edgeSettings.getSnapshot().status).toBe('idle')
    expect(typeof injected.load).toBe('function')
    expect(typeof injected.copyUpgrade).toBe('function')
  })
})
