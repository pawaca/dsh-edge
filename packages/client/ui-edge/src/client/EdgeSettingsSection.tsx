import { useEffect, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ApprovalMode,
  BashRouting,
  ContainerSleepMinutes,
  EdgeHealth,
  EdgeRuntimeState,
  EdgeSettingsState,
} from './store.ts'
import { DSH_EDGE_RELEASES_URL, upgradeCommand } from './store.ts'
import type { EdgeSettingsKey } from './locales.ts'
import css from './EdgeSettingsSection.module.css'

export interface EdgeSettingsInjected {
  hooks: { edgeSettings: SnapshotStore<EdgeSettingsState> }
  load(): Promise<void>
  copyUpgrade(): Promise<void>
  signOut(): Promise<void>
  setApprovalMode(mode: ApprovalMode): Promise<void>
  refreshRuntime(): Promise<void>
  setRuntimeSettings(patch: Partial<EdgeRuntimeState['settings']>): Promise<void>
  stopContainer(): Promise<void>
}

export type EdgeSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.edge'>
  & InjectFace<EdgeSettingsInjected>

/** Each deployment's capabilities, cumulative from the free tier up, and its cost. */
const CAPABILITIES = {
  'just-bash-direct': { can: ['capResearch'], cost: 'costFree' },
  'just-bash-isolated': { can: ['capResearch', 'capAnalyze'], cost: 'costPaid' },
  'linux-container': { can: ['capResearch', 'capAnalyze', 'capCode'], cost: 'costContainer' },
} as const satisfies Record<EdgeHealth['shell'], { can: readonly EdgeSettingsKey[]; cost: EdgeSettingsKey }>

const ROUTING_HELP = {
  auto: 'routingAutoHelp',
  light: 'routingLightHelp',
  container: 'routingContainerHelp',
} as const satisfies Record<BashRouting, EdgeSettingsKey>

const RUNTIME_ERRORS = {
  load: 'runtimeLoadFailed',
  save: 'runtimeSaveFailed',
  busy: 'containerBusy',
  stop: 'containerStopFailed',
} as const satisfies Record<NonNullable<EdgeSettingsState['runtimeError']>, EdgeSettingsKey>

function Row({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return <div className={css.row}><dt>{label}</dt><dd>{value}</dd></div>
}

function ContainerCard(props: EdgeSettingsSectionProps & { state: EdgeSettingsState }): ReactNode {
  const { state, refreshRuntime, setRuntimeSettings, stopContainer, t } = props
  const { runtime } = state
  const container = runtime?.container ?? null
  const busy = state.runtimeSaving || state.containerStopping
  return (
    <section className={css.card} aria-labelledby="edge-container-title">
      <h3 id="edge-container-title">{t('linuxContainer')}</h3>
      {runtime === undefined ? null : (
        <dl>
          {container === null ? null : (
            <>
              <Row label={t('containerStatus')} value={
                <span className={css.status}>
                  <StateDot state={container.running ? 'done' : 'idle'} />
                  {container.running ? t('containerRunning') : t('containerSleeping')}
                </span>
              } />
              <Row label={t('containerCommands')} value={`${String(container.runningCommands)} / ${String(container.maxConcurrentCommands)}`} />
            </>
          )}
          <Row label={t('bashRouting')} value={
            <>
              <select
                className={css.select}
                value={runtime.settings.bashRouting}
                disabled={busy}
                aria-label={t('bashRouting')}
                onChange={e => { void setRuntimeSettings({ bashRouting: e.target.value as BashRouting }) }}
              >
                <option value="auto">{t('routingAuto')}</option>
                <option value="light">{t('routingLight')}</option>
                <option value="container">{t('routingContainer')}</option>
              </select>
              <p className={css.notice}>{t(ROUTING_HELP[runtime.settings.bashRouting])}</p>
            </>
          } />
          <Row label={t('containerSleep')} value={
            <>
              <select
                className={css.select}
                value={runtime.settings.containerSleepMinutes}
                disabled={busy}
                aria-label={t('containerSleep')}
                onChange={e => { void setRuntimeSettings({ containerSleepMinutes: Number(e.target.value) as ContainerSleepMinutes }) }}
              >
                <option value={5}>{t('sleep5')}</option>
                <option value={10}>{t('sleep10')}</option>
                <option value={30}>{t('sleep30')}</option>
              </select>
              <p className={css.notice}>{t('containerSleepHelp')}</p>
            </>
          } />
        </dl>
      )}
      {state.runtimeSaved ? <p className={css.status}>{t('runtimeSaved')}</p> : null}
      {state.runtimeError === undefined ? null : <p className={css.error} role="alert">{t(RUNTIME_ERRORS[state.runtimeError])}</p>}
      <div className={css.actions}>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || container?.running !== true || container.runningCommands > 0}
          onClick={() => { void stopContainer() }}
        >
          {state.containerStopping ? t('sleepingNow') : t('sleepNow')}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void refreshRuntime() }}>{t('containerRefresh')}</Button>
      </div>
      <p className={css.notice}>{t('sleepNowHelp')}</p>
    </section>
  )
}

export function EdgeSettingsSection(props: EdgeSettingsSectionProps): ReactNode {
  const { useEdgeSettings, load, copyUpgrade, signOut, setApprovalMode, t } = props
  useEffect(() => { void load() }, [load])
  const state = useEdgeSettings(snapshot => snapshot)
  const deploymentDetails = state.status === 'idle' || state.status === 'loading'
    ? <p className={css.notice}>{t('loading')}</p>
    : state.status === 'error' || state.health === undefined
      ? (
        <div className={css.notice} role="alert">
          <p>{t('loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => { void load() }}>{t('retry')}</Button>
        </div>
      )
      : (
        <>
          <section className={css.card} aria-labelledby="edge-release-title">
            <h3 id="edge-release-title">{t('release')}</h3>
            <dl>
              <Row label={t('currentVersion')} value={state.health.version} />
              <Row label={t('updateChannel')} value={<code>{state.releaseChannel ?? '—'}</code>} />
              <Row label={t('latestVersion')} value={state.latestVersion ?? '—'} />
              <Row label={t('upstreamVersion')} value={state.health.upstreamVersion} />
            </dl>
            <p className={css.status}>
              {state.releaseStatus === undefined || state.releaseStatus === 'unavailable'
                ? null
                : <StateDot state={state.releaseStatus === 'update-available' ? 'warning' : 'done'} />}
              {state.releaseStatus === 'latest' ? t('latest') : state.releaseStatus === 'update-available' ? t('updateAvailable') : state.releaseStatus === 'development' ? t('development') : t('unavailable')}
            </p>
            <div className={css.actions}>
              {state.releaseStatus === 'update-available' ? <Button variant="outline" size="sm" onClick={() => { void copyUpgrade() }}>{state.copied ? t('copied') : t('copyUpgrade')}</Button> : null}
              <a href={DSH_EDGE_RELEASES_URL} target="_blank" rel="noreferrer">{t('releaseNotes')}</a>
            </div>
            {state.copyError === undefined ? null : <p className={css.error} role="alert">{t('copyFailed')}</p>}
          </section>
          <section className={css.card} aria-labelledby="edge-capabilities-title">
            <h3 id="edge-capabilities-title">{t('capabilities')}</h3>
            <dl>
              <Row label={t('capabilityList')} value={
                <ul className={css.capabilities}>
                  {CAPABILITIES[state.health.shell].can.map(key => <li key={key}>{t(key)}</li>)}
                </ul>
              } />
              <Row label={t('cost')} value={t(CAPABILITIES[state.health.shell].cost)} />
              <Row label={t('storage')} value={t('durableStorage')} />
              <Row label={t('deploymentId')} value={<code>{state.health.deploymentId}</code>} />
            </dl>
            <p>{t('changeCapabilities')}</p>
            <code>{upgradeCommand(state.health.version)}</code>
          </section>
          {state.health.shell === 'linux-container' ? <ContainerCard {...props} state={state} /> : null}
        </>
      )
  return (
    <div className={css.section}>
      <header><h2>{t('title')}</h2><p>{t('intro')}</p></header>
      {deploymentDetails}
      <section className={css.card} aria-labelledby="edge-approval-title">
        <h3 id="edge-approval-title">{t('toolPermissions')}</h3>
        <dl>
          <Row label={t('approvalMode')} value={
            <select
              className={css.select}
              value={state.approvalMode}
              disabled={state.approvalSaving || state.status !== 'ready'}
              aria-label={t('approvalMode')}
              onChange={e => { void setApprovalMode(e.target.value as ApprovalMode) }}
            >
              <option value="ask">{t('approvalAsk')}</option>
              <option value="never">{t('approvalNever')}</option>
            </select>
          } />
        </dl>
        {state.approvalSaved ? <p className={css.status}>{t('approvalSaved')}</p> : null}
        {state.approvalError !== undefined ? <p className={css.error} role="alert">{t('approvalError')}</p> : null}
      </section>
      <section className={css.card} aria-labelledby="edge-owner-title">
        <h3 id="edge-owner-title">{t('ownerSession')}</h3>
        <p>{t('ownerIntro')}</p>
        {state.signOutError === undefined ? null : <p className={css.error} role="alert">{t('signOutFailed')}</p>}
        <Button variant="outline" size="sm" disabled={state.signingOut} onClick={() => { void signOut() }}>
          {state.signingOut ? t('signingOut') : t('signOut')}
        </Button>
      </section>
    </div>
  )
}
