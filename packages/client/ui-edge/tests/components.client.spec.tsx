// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EdgeSettingsSection } from '../src/client/EdgeSettingsSection.tsx'
import type { EdgeSettingsSectionProps } from '../src/client/EdgeSettingsSection.tsx'
import { en } from '../src/client/locales.ts'
import type { EdgeSettingsState } from '../src/client/store.ts'

afterEach(cleanup)
const dictionary: Record<string, string> = en
const t: EdgeSettingsSectionProps['t'] = key => dictionary[key] ?? key
const runtime = {
  useSessions: (() => { throw new Error('unused') }) as never,
  useWorkspaces: (() => { throw new Error('unused') }) as never,
}

const READY: EdgeSettingsState = {
  status: 'ready',
  health: {
    ok: true,
    service: 'dsh-edge',
    storage: 'durable-object-sqlite-vfs',
    shell: 'just-bash-isolated',
    deploymentId: 'deploy-123',
    version: '1.0.0',
    upstreamVersion: '0.1.1-rc.1',
    status: 'ready',
  },
  copied: false,
  signingOut: false,
}

describe('Edge settings section', () => {
  it('renders deployment facts and delegates owner actions', () => {
    const load = vi.fn(() => Promise.resolve())
    const signOut = vi.fn(() => Promise.resolve())
    const { container } = render(<EdgeSettingsSection
      {...runtime}
      close={() => {}}
      t={t}
      useEdgeSettings={selector => selector(READY)}
      load={load}
      copyUpgrade={vi.fn(() => Promise.resolve())}
      signOut={signOut}
    />)
    expect(screen.getByText('Isolated · Dynamic Worker')).toBeTruthy()
    expect(screen.getByText('deploy-123')).toBeTruthy()
    expect(screen.getByText('Could not check npm')).toBeTruthy()
    expect(container.querySelector('[data-state="done"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(signOut).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledOnce()
  })

  it('contains load failure behind a retry action', () => {
    const load = vi.fn(() => Promise.resolve())
    const signOut = vi.fn(() => Promise.resolve())
    render(<EdgeSettingsSection
      {...runtime}
      close={() => {}}
      t={t}
      useEdgeSettings={selector => selector({
        status: 'error', error: 'private transport detail', copied: false, signingOut: false,
      })}
      load={load}
      copyUpgrade={vi.fn(() => Promise.resolve())}
      signOut={signOut}
    />)
    expect(screen.getByRole('alert').textContent).not.toContain('private transport detail')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(load).toHaveBeenCalledTimes(2)
    expect(signOut).toHaveBeenCalledOnce()
  })
})
