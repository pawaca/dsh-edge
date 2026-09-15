import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ApprovalMode, McpServerEntry, EdgeSettingsState } from './store.ts'
import { DSH_EDGE_RELEASES_URL } from './store.ts'
import css from './EdgeSettingsSection.module.css'

export interface EdgeSettingsInjected {
  hooks: { edgeSettings: SnapshotStore<EdgeSettingsState> }
  load(): Promise<void>
  copyUpgrade(): Promise<void>
  signOut(): Promise<void>
  setApprovalMode(mode: ApprovalMode): Promise<void>
  saveMcpServers(servers: McpServerEntry[]): Promise<void>
  restartRuntime(): Promise<void>
}

export type EdgeSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.edge'>
  & InjectFace<EdgeSettingsInjected>

function Row({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return <div className={css.row}><dt>{label}</dt><dd>{value}</dd></div>
}

interface McpServersCardProps {
  servers: McpServerEntry[]
  saving: boolean
  error?: string | undefined
  restartNeeded: boolean
  disabled: boolean
  onSave: (servers: McpServerEntry[]) => Promise<void>
  onRestart: () => Promise<void>
  t: EdgeSettingsSectionProps['t']
}

function McpServersCard(props: McpServersCardProps): ReactNode {
  const { servers, saving, disabled, error, restartNeeded } = props
  const onSave = props.onSave
  const onRestart = props.onRestart
  // eslint-disable-next-line @typescript-eslint/unbound-method -- t is a bound translate function passed from props
  const t = props.t
  const [draft, setDraft] = useState<{ serverName: string; url: string }>({ serverName: '', url: '' })
  const addServer = useCallback(() => {
    if (draft.serverName.trim() === '' || draft.url.trim() === '') return
    void onSave([...servers, {
      serverName: draft.serverName.trim(),
      url: draft.url.trim(),
    } as McpServerEntry]).then(() => { setDraft({ serverName: '', url: '' }) })
  }, [draft, servers, onSave])
  const removeServer = useCallback((name: string) => {
    void onSave(servers.filter(s => s.serverName !== name))
  }, [servers, onSave])

  return (
    <section className={css.card} aria-labelledby="edge-mcp-title">
      <h3 id="edge-mcp-title">{t('mcpServers')}</h3>
      <p>{t('mcpIntro')}</p>
      {servers.length > 0 ? (
        <ul className={css.mcpList}>
          {servers.map(s => (
            <li key={s.serverName} className={css.mcpItem}>
              <span className={css.mcpName}>{s.serverName}</span>
              <code className={css.mcpUrl}>{s.url}</code>
              <Button variant="outline" size="sm" disabled={saving || disabled}
                onClick={() => removeServer(s.serverName)}>{t('mcpRemove')}</Button>
            </li>
          ))}
        </ul>
      ) : <p className={css.notice}>{t('mcpEmpty')}</p>}
      <div className={css.mcpAdd}>
        <input className={css.input} placeholder={t('mcpNamePlaceholder')}
          value={draft.serverName} disabled={saving || disabled}
          onChange={e => setDraft(d => ({ ...d, serverName: e.target.value }))} />
        <input className={css.input} placeholder={t('mcpUrlPlaceholder')}
          value={draft.url} disabled={saving || disabled}
          onChange={e => setDraft(d => ({ ...d, url: e.target.value }))} />
        <Button variant="outline" size="sm"
          disabled={saving || disabled || draft.serverName.trim() === '' || draft.url.trim() === ''}
          onClick={addServer}>{t('mcpAdd')}</Button>
      </div>
      {restartNeeded ? (
        <div className={css.restartBanner}>
          <p>{t('mcpRestartNeeded')}</p>
          <Button variant="outline" size="sm" onClick={() => { void onRestart() }}>{t('mcpRestart')}</Button>
        </div>
      ) : null}
      {error !== undefined ? <p className={css.error} role="alert">{error}</p> : null}
    </section>
  )
}

export function EdgeSettingsSection(props: EdgeSettingsSectionProps): ReactNode {
  const { useEdgeSettings, load, copyUpgrade, signOut, setApprovalMode, saveMcpServers, restartRuntime, t } = props
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
      <McpServersCard
        servers={state.mcpServers}
        saving={state.mcpSaving}
        error={state.mcpError}
        restartNeeded={state.mcpRestartNeeded}
        disabled={state.status !== 'ready'}
        onSave={saveMcpServers}
        onRestart={restartRuntime}
        t={t}
      />
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
