import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { McpAuthType, McpToolPolicyMode, McpServerEntry, EdgeSettingsState } from './store.ts'
import css from './EdgeSettingsSection.module.css'

export interface EdgeMcpInjected {
  hooks: { edgeSettings: SnapshotStore<EdgeSettingsState> }
  load(): Promise<void>
  saveMcpServers(servers: McpServerEntry[]): Promise<boolean>
  saveMcpToken(serverName: string, token: string): Promise<boolean>
  setMcpToolPolicy(serverName: string, mode: McpToolPolicyMode): Promise<boolean>
  startOAuthConnect(serverName: string, serverUrl: string): Promise<string | undefined>
}

export type EdgeMcpSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.edge'>
  & InjectFace<EdgeMcpInjected>

function ChevronIcon({ expanded }: { expanded: boolean }): ReactNode {
  return (
    <span className={`${css.mcpChevron}${expanded ? ` ${css.mcpChevronOpen}` : ''}`}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
    </span>
  )
}

function statusText(s: McpServerEntry, t: EdgeMcpSectionProps['t']): string {
  if (s.status === 'connected') return `${s.toolCount ?? 0} ${t('mcpTools')} · ${t('mcpConnected')}`
  if (s.status === 'needs_reauth') return t('mcpNeedsReauth')
  if (s.status === 'error') return t('mcpError')
  return ''
}

interface McpConnectorCardProps {
  server: McpServerEntry
  saving: boolean
  disabled: boolean
  expanded: boolean
  onToggle: () => void
  onRemove: () => void
  onSetToolPolicy: (mode: McpToolPolicyMode) => void
  onOAuthConnect: () => void
  t: EdgeMcpSectionProps['t']
}

function McpConnectorCard({ server: s, saving, disabled, expanded, onToggle, onRemove, onSetToolPolicy, onOAuthConnect, t }: McpConnectorCardProps): ReactNode {
  const hasTools = s.toolCount !== undefined && s.toolCount > 0
  const authLabel = s.auth?.type === 'oauth' ? 'OAuth 2.1' : s.auth?.type === 'bearer' ? 'Bearer Token' : t('mcpAuthNone')
  return (
    <div className={`${css.mcpCard}${expanded ? ` ${css.mcpCardOpen}` : ''}`}>
      <button type="button" className={css.mcpCardHeader} onClick={onToggle}>
        <div className={css.mcpAvatar}>{s.serverName.charAt(0).toUpperCase()}</div>
        <div className={css.mcpCardTitleGroup}>
          <p className={css.mcpCardName}>{s.serverName}</p>
          <div className={css.mcpCardSub}>
            {s.status !== undefined ? <span className={css.mcpBadge} data-status={s.status}>{statusText(s, t)}</span> : null}
            {s.auth?.type !== undefined && s.auth.type !== 'none' ? (
              <span className={css.mcpBadge} data-status="unknown">{s.auth.type.toUpperCase()}</span>
            ) : null}
          </div>
        </div>
        <ChevronIcon expanded={expanded} />
      </button>
      {expanded ? (
        <div className={css.mcpCardBody}>
          <div className={css.mcpFieldRow}>
            <span className={css.mcpFieldLabel}>URL</span>
            <code className={css.mcpFieldValue} style={{ fontSize: 12, wordBreak: 'break-all' }}>{s.url}</code>
          </div>
          <div className={css.mcpFieldRow}>
            <span className={css.mcpFieldLabel}>{t('mcpAuthLabel')}</span>
            <span className={css.mcpFieldValue}>{authLabel}</span>
          </div>
          {s.serverInfo?.name !== undefined ? (
            <div className={css.mcpFieldRow}>
              <span className={css.mcpFieldLabel}>{t('mcpServerInfo')}</span>
              <span className={css.mcpFieldValue}>{s.serverInfo.name}{s.serverInfo.version !== undefined ? ` v${s.serverInfo.version}` : ''}</span>
            </div>
          ) : null}
          {(s.status === 'connected' || hasTools) ? (
            <div className={css.mcpFieldRow}>
              <span className={css.mcpFieldLabel}>{t('mcpToolPolicy')}</span>
              <select className={css.select} value={s.toolPolicy?.mode ?? 'read_only'}
                disabled={saving || disabled}
                aria-label={t('mcpToolPolicy')}
                onChange={e => onSetToolPolicy(e.target.value as McpToolPolicyMode)}>
                <option value="approve_all">{t('mcpPolicyApproveAll')}</option>
                <option value="read_only">{t('mcpPolicyReadOnly')}</option>
                <option value="allow_all">{t('mcpPolicyAllowAll')}</option>
              </select>
            </div>
          ) : null}
          {s.auth?.type === 'oauth' && s.status !== 'connected' ? (
            <div className={css.mcpFieldRow}>
              <span className={css.mcpFieldLabel} />
              <Button variant="outline" size="sm" disabled={saving || disabled}
                onClick={onOAuthConnect}>{s.status === 'needs_reauth' ? t('mcpReconnect') : t('mcpConnect')}</Button>
            </div>
          ) : null}
          <div className={css.mcpCardActions}>
            <Button variant="outline" size="sm" disabled={saving || disabled}
              onClick={onRemove}>{t('mcpRemove')}</Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function EdgeMcpSection(props: EdgeMcpSectionProps): ReactNode {
  const { useEdgeSettings, load, saveMcpServers, saveMcpToken, setMcpToolPolicy, startOAuthConnect, t } = props
  useEffect(() => { void load() }, [load])
  const state = useEdgeSettings(snapshot => snapshot)
  const servers = state.mcpServers
  const saving = state.mcpSaving
  const disabled = state.status !== 'ready' || !state.mcpLoaded
  const error = state.mcpError

  const [expandedServer, setExpandedServer] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [draft, setDraft] = useState<{ serverName: string; url: string; authType: McpAuthType; token: string }>({ serverName: '', url: '', authType: 'none', token: '' })

  const addServer = useCallback(() => {
    if (draft.serverName.trim() === '' || draft.url.trim() === '') return
    const entry: McpServerEntry = {
      serverName: draft.serverName.trim(),
      url: draft.url.trim(),
      auth: { type: draft.authType },
    }
    void (async () => {
      const name = draft.serverName.trim()
      if (!/^[A-Za-z0-9_-]{1,32}$/u.test(name)) return
      try { new URL(draft.url.trim()) } catch { return }
      if (servers.some(s => s.serverName === name)) return
      if (draft.authType === 'bearer' && draft.token.trim() !== '') {
        const tokenOk = await saveMcpToken(name, draft.token.trim())
        if (!tokenOk) return
      }
      const ok = await saveMcpServers([...servers, entry])
      if (!ok) return
      setDraft({ serverName: '', url: '', authType: 'none', token: '' })
      setShowAddForm(false)
    })()
  }, [draft, servers, saveMcpServers, saveMcpToken])

  const removeServer = useCallback((name: string) => {
    void saveMcpServers(servers.filter(s => s.serverName !== name))
    if (expandedServer === name) setExpandedServer(null)
  }, [servers, saveMcpServers, expandedServer])

  if (state.status === 'idle' || state.status === 'loading') {
    return <div className={css.section}><p className={css.notice}>{t('loading')}</p></div>
  }

  return (
    <div className={css.section}>
      <header>
        <h2>{t('mcpServers')}</h2>
        <p style={{ margin: '4px 0 0' }}>{t('mcpIntro')}</p>
      </header>
      {servers.length > 0 ? (
        <ul className={css.mcpList}>
          {servers.map(s => (
            <li key={s.serverName}>
              <McpConnectorCard server={s}
                saving={saving} disabled={disabled}
                expanded={expandedServer === s.serverName}
                onToggle={() => setExpandedServer(prev => prev === s.serverName ? null : s.serverName)}
                onRemove={() => removeServer(s.serverName)}
                onSetToolPolicy={mode => { void setMcpToolPolicy(s.serverName, mode) }}
                onOAuthConnect={() => {
                  void startOAuthConnect(s.serverName, s.url).then(authUrl => {
                    if (authUrl !== undefined) globalThis.open(authUrl, '_blank', 'width=600,height=700')
                  })
                }}
                t={t}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {!showAddForm ? (
        <button type="button" className={css.mcpAddTrigger} disabled={saving || disabled}
          onClick={() => setShowAddForm(true)}>+ {t('mcpAddServer')}</button>
      ) : (
        <div className={css.mcpAddForm}>
          <div className={css.mcpFormRow}>
            <input className={css.input} placeholder={t('mcpNamePlaceholder')}
              value={draft.serverName} disabled={saving || disabled}
              onChange={e => setDraft(d => ({ ...d, serverName: e.target.value }))} />
            <input className={css.input} placeholder={t('mcpUrlPlaceholder')}
              value={draft.url} disabled={saving || disabled}
              onChange={e => setDraft(d => ({ ...d, url: e.target.value }))} />
          </div>
          <div className={css.mcpFormRow}>
            <select className={css.select} style={{ width: '100%' }} value={draft.authType} disabled={saving || disabled}
              aria-label="Auth type"
              onChange={e => setDraft(d => ({ ...d, authType: e.target.value as McpAuthType }))}>
              <option value="none">{t('mcpAuthNone')}</option>
              <option value="bearer">{t('mcpAuthBearer')}</option>
              <option value="oauth">{t('mcpAuthOAuth')}</option>
            </select>
            {draft.authType === 'bearer' ? (
              <input className={css.input} type="password" placeholder={t('mcpTokenPlaceholder')}
                value={draft.token} disabled={saving || disabled}
                onChange={e => setDraft(d => ({ ...d, token: e.target.value }))} />
            ) : <div />}
          </div>
          <div className={css.mcpFormActions}>
            <Button variant="outline" size="sm" onClick={() => { setShowAddForm(false); setDraft({ serverName: '', url: '', authType: 'none', token: '' }) }}>{t('mcpCancel')}</Button>
            <Button variant="outline" size="sm"
              disabled={saving || disabled || draft.serverName.trim() === '' || draft.url.trim() === ''
                || (draft.authType === 'bearer' && draft.token.trim() === '')}
              onClick={addServer}>{t('mcpAdd')}</Button>
          </div>
        </div>
      )}
      {error !== undefined ? <p className={css.error} role="alert">{error}</p> : null}
    </div>
  )
}
