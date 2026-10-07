// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EdgeSettingsSection } from '../src/client/EdgeSettingsSection.tsx'
import type { EdgeSettingsSectionProps } from '../src/client/EdgeSettingsSection.tsx'
import { en } from '../src/client/locales.ts'
import { EdgePluginSettingsTab } from '../src/client/EdgePluginSettingsTab.tsx'
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
  approvalMode: 'ask',
  approvalSaving: false,
  approvalSaved: false,
  mcpServers: [],
  mcpLoaded: true,
  mcpSaving: false,
  runtimeSaving: false,
  runtimeSaved: false,
  containerStopping: false,
}

const CONTAINER_READY: EdgeSettingsState = {
  ...READY,
  health: { ...READY.health!, shell: 'linux-container' },
  runtime: {
    settings: { bashRouting: 'auto', containerSleepMinutes: 10 },
    container: { running: true, runningCommands: 0, maxConcurrentCommands: 2, lastActivityAt: 1 },
  },
}

function runtimeActions() {
  return {
    refreshRuntime: vi.fn(() => Promise.resolve()),
    setRuntimeSettings: vi.fn(() => Promise.resolve()),
    stopContainer: vi.fn(() => Promise.resolve()),
  }
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
      setApprovalMode={vi.fn(() => Promise.resolve())}
      {...runtimeActions()}
    />)
    expect(screen.getByText('Research and write')).toBeTruthy()
    expect(screen.getByText('Analyze data and split big jobs')).toBeTruthy()
    expect(screen.queryByText('Work on code projects')).toBeNull()
    expect(screen.getByText('npx dsh-edge@latest upgrade')).toBeTruthy()
    expect(screen.queryByText('Linux container')).toBeNull()
    expect(screen.getByText('deploy-123')).toBeTruthy()
    expect(screen.getByText('Could not check npm')).toBeTruthy()
    expect(container.querySelector('[data-state="done"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(signOut).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledOnce()
  })

  it('shows Container capabilities, status, and live settings', () => {
    const actions = runtimeActions()
    render(<EdgeSettingsSection
      {...runtime}
      close={() => {}}
      t={t}
      useEdgeSettings={selector => selector(CONTAINER_READY)}
      load={vi.fn(() => Promise.resolve())}
      copyUpgrade={vi.fn(() => Promise.resolve())}
      signOut={vi.fn(() => Promise.resolve())}
      setApprovalMode={vi.fn(() => Promise.resolve())}
      {...actions}
    />)
    expect(screen.getByText('Work on code projects')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByText('0 / 2')).toBeTruthy()
    expect(screen.getByText(en.routingAutoHelp)).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Where commands run' }), { target: { value: 'light' } })
    expect(actions.setRuntimeSettings).toHaveBeenCalledWith({ bashRouting: 'light' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Sleep after idle' }), { target: { value: '30' } })
    expect(actions.setRuntimeSettings).toHaveBeenCalledWith({ containerSleepMinutes: 30 })
    fireEvent.click(screen.getByRole('button', { name: 'Sleep now' }))
    expect(actions.stopContainer).toHaveBeenCalledOnce()
  })

  it('offers sleep now only for an idle running container', () => {
    const busy: EdgeSettingsState = {
      ...CONTAINER_READY,
      runtime: { ...CONTAINER_READY.runtime!, container: { ...CONTAINER_READY.runtime!.container!, runningCommands: 1 } },
    }
    const asleep: EdgeSettingsState = {
      ...CONTAINER_READY,
      runtime: { ...CONTAINER_READY.runtime!, container: { ...CONTAINER_READY.runtime!.container!, running: false } },
    }
    for (const state of [busy, asleep]) {
      render(<EdgeSettingsSection
        {...runtime}
        close={() => {}}
        t={t}
        useEdgeSettings={selector => selector(state)}
        load={vi.fn(() => Promise.resolve())}
        copyUpgrade={vi.fn(() => Promise.resolve())}
        signOut={vi.fn(() => Promise.resolve())}
        setApprovalMode={vi.fn(() => Promise.resolve())}
        {...runtimeActions()}
      />)
      expect((screen.getByRole('button', { name: 'Sleep now' }) as HTMLButtonElement).disabled).toBe(true)
      cleanup()
    }
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
        approvalMode: 'ask', approvalSaving: false, approvalSaved: false,
        mcpServers: [], mcpLoaded: false, mcpSaving: false,
        runtimeSaving: false, runtimeSaved: false, containerStopping: false,
      })}
      load={load}
      copyUpgrade={vi.fn(() => Promise.resolve())}
      signOut={signOut}
      setApprovalMode={vi.fn(() => Promise.resolve())}
      {...runtimeActions()}
    />)
    expect(screen.getByRole('alert').textContent).not.toContain('private transport detail')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(load).toHaveBeenCalledTimes(2)
    expect(signOut).toHaveBeenCalledOnce()
  })
})

describe('EdgePluginSettingsTab', () => {
  afterEach(cleanup)
  const t = (key: keyof typeof en) => en[key]

  it('says when no plugin offers settings', () => {
    render(<EdgePluginSettingsTab t={t} renderSlot={() => null} usePluginSettingsItems={select => select([])} />)
    expect(screen.getByText(en.pluginSettingsEmpty)).toBeTruthy()
  })

  it('renders each card as its title, summary, then settings page', () => {
    const calls: Array<[string, string]> = []
    render(<EdgePluginSettingsTab
      t={t}
      usePluginSettingsItems={select => select([{ id: 'agent-loop', label: 'Agent loop' }, { id: 'web-search', label: 'Web search' }])}
      renderSlot={(_name, props, options) => {
        calls.push([options.only, props.view])
        return <span>{`${options.only}:${props.view}`}</span>
      }}
    />)
    expect(screen.getByRole('heading', { name: 'Agent loop' })).toBeTruthy()
    expect(screen.getByText('web-search:page')).toBeTruthy()
    expect(calls).toEqual([
      ['agent-loop', 'summary'], ['agent-loop', 'page'],
      ['web-search', 'summary'], ['web-search', 'page'],
    ])
  })
})
