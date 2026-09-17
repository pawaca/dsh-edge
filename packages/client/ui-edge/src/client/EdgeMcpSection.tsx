import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { McpAuthType, McpToolPolicyMode, McpServerEntry, McpToolEntry, EdgeSettingsState } from './store.ts'
import css from './EdgeSettingsSection.module.css'

export interface EdgeMcpInjected {
  hooks: { edgeSettings: SnapshotStore<EdgeSettingsState> }
  load(): Promise<void>
  saveMcpServers(servers: McpServerEntry[]): Promise<boolean>
  saveMcpToken(serverName: string, token: string): Promise<boolean>
  setMcpToolPolicy(serverName: string, mode: McpToolPolicyMode): Promise<boolean>
  probeMcpServer(serverName: string): Promise<boolean>
  getMcpTools(serverName: string): Promise<McpToolEntry[]>
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


interface McpConnectorCardProps {
  server: McpServerEntry
  saving: boolean
  disabled: boolean
  expanded: boolean
  onToggle: () => void
  onRemove: () => void
  onSetToolPolicy: (mode: McpToolPolicyMode) => void
  onProbe: () => Promise<boolean>
  onGetTools: () => Promise<McpToolEntry[]>
  onOAuthConnect: () => void
  connecting: boolean
  t: EdgeMcpSectionProps['t']
}

function McpConnectorCard({ server: s, saving, disabled, expanded, onToggle, onRemove, onSetToolPolicy, onProbe, onGetTools, onOAuthConnect, connecting, t }: McpConnectorCardProps): ReactNode {
  const hasTools = s.toolCount !== undefined && s.toolCount > 0
  const [probing, setProbing] = useState(false)
  const [tools, setTools] = useState<McpToolEntry[] | null>(null)
  const [toolsLoading, setToolsLoading] = useState(false)

  useEffect(() => {
    if (expanded && hasTools && tools === null && !toolsLoading) {
      setToolsLoading(true)
      void onGetTools().then(t => { setTools(t); setToolsLoading(false) })
    }
    if (!expanded) setTools(null)
  }, [expanded, hasTools])
  const authLabel = s.auth?.type === 'oauth' ? 'OAuth 2.1' : s.auth?.type === 'bearer' ? 'Bearer Token' : t('mcpAuthNone')
  return (
    <div className={`${css.mcpCard}${expanded ? ` ${css.mcpCardOpen}` : ''}`}>
      <button type="button" className={css.mcpCardHeader} aria-expanded={expanded} onClick={onToggle}>
        <div className={css.mcpAvatar}>{s.serverName.charAt(0).toUpperCase()}</div>
        <div className={css.mcpCardTitleGroup}>
          <p className={css.mcpCardName}>{s.serverName}</p>
          <div className={css.mcpCardSub}>
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
          {s.status === 'connected' ? (
            <p className={css.mcpCardSuccess}>{s.toolCount ?? 0} {t('mcpTools')} · {t('mcpConnected')}</p>
          ) : s.status === 'error' ? (
            <p className={css.mcpCardError}>{t('mcpConnectionFailed')}</p>
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
          {hasTools && tools !== null && tools.length > 0 ? (
            <div className={css.mcpToolList}>
              <span className={css.mcpFieldLabel}>{t('mcpToolsLabel')} ({tools.length})</span>
              <ul className={css.mcpToolItems}>
                {tools.map(tool => (
                  <li key={tool.publicName} className={css.mcpToolItem}>
                    <code className={css.mcpToolName}>{tool.name}</code>
                    {tool.readOnly === true ? <span className={css.mcpBadge} data-status="connected">{t('mcpRead')}</span>
                      : tool.readOnly === false ? <span className={css.mcpBadge} data-status="error">{t('mcpWrite')}</span>
                      : null}
                    <span className={css.mcpToolDesc}>{tool.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : toolsLoading ? <span className={css.mcpFieldLabel}>{t('loading')}</span> : null}
          <div className={css.mcpCardActions}>
            {s.auth?.type === 'oauth' && s.status !== 'connected' ? (
              <Button variant="outline" size="sm" disabled={saving || disabled || connecting}
                onClick={onOAuthConnect}>{connecting ? t('mcpConnecting') : s.status === 'needs_reauth' ? t('mcpReconnect') : t('mcpConnect')}</Button>
            ) : (
              <Button variant="outline" size="sm" disabled={saving || disabled || probing}
                onClick={() => { setProbing(true); void onProbe().then(() => onGetTools().then(setTools)).finally(() => setProbing(false)) }}>
                {probing ? t('mcpProbing') : t('mcpRefresh')}</Button>
            )}
            <Button variant="outline" size="sm" disabled={saving || disabled}
              onClick={onRemove}>{t('mcpRemove')}</Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function EdgeMcpSection(props: EdgeMcpSectionProps): ReactNode {
  const { useEdgeSettings, load, saveMcpServers, saveMcpToken, setMcpToolPolicy, probeMcpServer, getMcpTools, startOAuthConnect, t } = props
  useEffect(() => { void load() }, [load])
  const state = useEdgeSettings(snapshot => snapshot)
  const servers = state.mcpServers
  const saving = state.mcpSaving
  const disabled = state.status !== 'ready' || !state.mcpLoaded
  const [expandedServer, setExpandedServer] = useState<string | null>(null)
  const [connectingServer, setConnectingServer] = useState<string | null>(null)
  const [popupError, setPopupError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'mcp-oauth-complete') {
        setConnectingServer(null)
      }
    }
    globalThis.addEventListener?.('message', handler)
    return () => globalThis.removeEventListener?.('message', handler)
  }, [])
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
      const addedName = name
      const addedUrl = draft.url.trim()
      const addedAuth = draft.authType
      setDraft({ serverName: '', url: '', authType: 'none', token: '' })
      setShowAddForm(false)
      setExpandedServer(addedName)
      if (addedAuth === 'oauth') {
        setConnectingServer(addedName)
        const authUrl = await startOAuthConnect(addedName, addedUrl)
        if (authUrl === undefined) { setConnectingServer(null) } else {
          const popup = globalThis.open(authUrl, '_blank', 'width=600,height=700')
          if (!popup) { setConnectingServer(null); setPopupError(addedName) } else {
            const check = setInterval(() => {
              if (popup.closed) { clearInterval(check); setConnectingServer(c => c === addedName ? null : c) }
            }, 500)
          }
        }
      }
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
                onProbe={() => probeMcpServer(s.serverName)}
                onGetTools={() => getMcpTools(s.serverName)}
                onOAuthConnect={() => {
                  setConnectingServer(s.serverName); setPopupError(null)
                  void startOAuthConnect(s.serverName, s.url).then(authUrl => {
                    if (authUrl === undefined) { setConnectingServer(null); return }
                    const popup = globalThis.open(authUrl, '_blank', 'width=600,height=700')
                    if (!popup) {
                      setConnectingServer(null)
                      setPopupError(s.serverName)
                      return
                    }
                    const check = setInterval(() => {
                      if (popup.closed) { clearInterval(check); setConnectingServer(c => c === s.serverName ? null : c) }
                    }, 500)
                  })
                }}
                connecting={connectingServer === s.serverName}
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
      {popupError !== null ? <p className={css.error} role="alert">{t('mcpPopupBlocked')}</p> : null}
      {state.mcpError !== undefined && popupError === null ? <p className={css.error} role="alert">{state.mcpError}</p> : null}
    </div>
  )
}
