import { useEffect, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { EdgeSettingsState } from './store.ts'
import { DSH_EDGE_RELEASES_URL } from './store.ts'
import css from './EdgeSettingsSection.module.css'

export interface EdgeSettingsInjected {
  hooks: { edgeSettings: SnapshotStore<EdgeSettingsState> }
  load(): Promise<void>
  copyUpgrade(): Promise<void>
  signOut(): Promise<void>
}

export type EdgeSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.edge'>
  & InjectFace<EdgeSettingsInjected>

function Row({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return <div className={css.row}><dt>{label}</dt><dd>{value}</dd></div>
}

export function EdgeSettingsSection(props: EdgeSettingsSectionProps): ReactNode {
  const { useEdgeSettings, load, copyUpgrade, signOut, t } = props
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
          <section className={css.card} aria-labelledby="edge-runtime-title">
            <h3 id="edge-runtime-title">{t('runtime')}</h3>
            <dl>
              <Row label={t('runtime')} value={state.health.shell === 'just-bash-direct' ? t('direct') : t('isolated')} />
              <Row label={t('storage')} value={t('durableStorage')} />
              <Row label={t('deploymentId')} value={<code>{state.health.deploymentId}</code>} />
            </dl>
          </section>
        </>
      )
  return (
    <div className={css.section}>
      <header><h2>{t('title')}</h2><p>{t('intro')}</p></header>
      {deploymentDetails}
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
