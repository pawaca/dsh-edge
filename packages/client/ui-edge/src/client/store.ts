import { compareVersions, validate } from 'compare-versions'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Public release history for the Edge distribution. */
export const DSH_EDGE_RELEASES_URL = 'https://github.com/pawaca/dsh-edge/releases'

export type EdgeReleaseChannel = 'latest' | 'next'

/** Stable deployments follow latest; prerelease deployments stay on next. */
export function releaseChannel(version: string): EdgeReleaseChannel {
  return validate(version) && version.includes('-') ? 'next' : 'latest'
}

/** Repeatable command for upgrading without crossing release channels. */
export function upgradeCommand(version: string): string {
  return `npx dsh-edge@${releaseChannel(version)} upgrade`
}

/** Stable deployment facts projected by the Edge health endpoint. */
export interface EdgeHealth {
  ok: true
  service: 'dsh-edge'
  storage: 'durable-object-sqlite-vfs'
  shell: 'just-bash-direct' | 'just-bash-isolated'
  deploymentId: string
  version: string
  upstreamVersion: string
  status: 'ready'
}

export type ApprovalMode = 'ask' | 'never'

export type McpAuthType = 'none' | 'bearer' | 'oauth'

export interface McpServerEntry {
  serverName: string
  url: string
  auth?: { type: McpAuthType } | undefined
  status?: 'unknown' | 'connected' | 'error' | 'needs_reauth' | undefined
  toolCount?: number | undefined
  toolCallTimeoutMs?: number
}

/** Browser-owned state for the Edge settings section. */
export interface EdgeSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  health?: EdgeHealth
  latestVersion?: string
  releaseChannel?: EdgeReleaseChannel
  releaseStatus?: 'development' | 'latest' | 'update-available' | 'unavailable'
  error?: string
  copied: boolean
  copyError?: string
  signingOut: boolean
  signOutError?: string
  approvalMode: ApprovalMode
  approvalSaving: boolean
  approvalSaved: boolean
  approvalError?: string
  mcpServers: McpServerEntry[]
  mcpLoaded: boolean
  mcpSaving: boolean
  mcpError?: string
  mcpRestartNeeded: boolean
}

/** Side-effect boundary used by the Edge settings controller. */
export interface EdgeSettingsIO {
  fetch(input: string, init?: RequestInit): Promise<Response>
  copy(text: string): Promise<void>
  navigate(path: string): void
}

function releaseStatus(current: string, latest?: string): NonNullable<EdgeSettingsState['releaseStatus']> {
  if (!validate(current) || current === '0.0.0') return 'development'
  if (latest === undefined || !validate(latest)) return 'unavailable'
  return compareVersions(latest, current) > 0 ? 'update-available' : 'latest'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isHealth(value: unknown): value is EdgeHealth {
  if (value === null || typeof value !== 'object') return false
  const health = value as Partial<EdgeHealth>
  return health.ok === true
    && health.service === 'dsh-edge'
    && health.status === 'ready'
    && (health.shell === 'just-bash-direct' || health.shell === 'just-bash-isolated')
    && health.storage === 'durable-object-sqlite-vfs'
    && typeof health.deploymentId === 'string'
    && typeof health.version === 'string'
    && typeof health.upstreamVersion === 'string'
}

/** Lazy, fail-soft controller for the Edge deployment settings page. */
export class EdgeSettingsController {
  /** Observable settings state consumed by the client runtime. */
  readonly store: SnapshotStore<EdgeSettingsState> = createSnapshotStore({
    status: 'idle', copied: false, signingOut: false,
    approvalMode: 'ask', approvalSaving: false, approvalSaved: false,
    mcpServers: [], mcpLoaded: false, mcpSaving: false, mcpRestartNeeded: false,
  })
  private loadGeneration = 0
  private approvalGeneration = 0
  private mcpGeneration = 0
  private oauthMessageHandler: ((e: MessageEvent) => void) | undefined

  constructor(private readonly io: EdgeSettingsIO) {
    this.oauthMessageHandler = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'mcp-oauth-complete') void this.refreshMcpServers()
    }
    globalThis.addEventListener?.('message', this.oauthMessageHandler)
  }

  dispose(): void {
    if (this.oauthMessageHandler !== undefined) {
      globalThis.removeEventListener?.('message', this.oauthMessageHandler)
      this.oauthMessageHandler = undefined
    }
  }

  /** Load the current deployment projection without affecting owner-session state. */
  async load(): Promise<void> {
    const generation = ++this.loadGeneration
    this.store.update((state) => { state.status = 'loading'; state.mcpLoaded = false; delete state.error })
    try {
      const healthResponse = await this.io.fetch('/api/health', { credentials: 'same-origin' })
      if (!healthResponse.ok) throw new Error(`HTTP ${String(healthResponse.status)}`)
      const health: unknown = await healthResponse.json()
      if (!isHealth(health)) throw new Error('Invalid Edge health response')

      if (generation !== this.loadGeneration) return
      const channel = releaseChannel(health.version)
      this.store.update((state) => {
        state.status = 'ready'
        state.health = health
        state.releaseChannel = channel
        state.releaseStatus = releaseStatus(health.version)
        delete state.latestVersion
        delete state.error
      })

      const approvalGen = ++this.approvalGeneration
      try {
        const approvalResponse = await this.io.fetch('/api/approval-mode', { credentials: 'same-origin' })
        if (approvalGen === this.approvalGeneration) {
          if (approvalResponse.ok) {
            const data = await approvalResponse.json() as { mode?: string }
            if (approvalGen === this.approvalGeneration && (data.mode === 'ask' || data.mode === 'never')) {
              this.store.update((state) => { state.approvalMode = data.mode as ApprovalMode; delete state.approvalError })
            }
          } else {
            this.store.update((state) => { state.approvalError = `HTTP ${String(approvalResponse.status)}` })
          }
        }
      } catch {
        if (approvalGen === this.approvalGeneration) {
          this.store.update((state) => { state.approvalError = 'Could not load approval setting.' })
        }
      }

      const mcpGen = ++this.mcpGeneration
      try {
        const mcpResponse = await this.io.fetch('/api/mcp-servers', { credentials: 'same-origin' })
        if (mcpGen === this.mcpGeneration && mcpResponse.ok) {
          const data = await mcpResponse.json() as { servers?: McpServerEntry[]; restartRequired?: boolean }
          if (mcpGen === this.mcpGeneration && Array.isArray(data.servers)) {
            this.store.update((state) => {
              state.mcpServers = data.servers as McpServerEntry[]
              state.mcpLoaded = true
              state.mcpRestartNeeded = data.restartRequired === true
            })
          }
        }
      } catch { /* MCP list defaults to empty */ }

      let latestVersion: string | undefined
      try {
        const releaseResponse = await this.io.fetch(`https://registry.npmjs.org/dsh-edge/${channel}`, {
          signal: AbortSignal.timeout(5_000),
        })
        if (releaseResponse.ok) {
          const release: unknown = await releaseResponse.json()
          if (release !== null && typeof release === 'object'
            && typeof (release as { version?: unknown }).version === 'string') {
            latestVersion = (release as { version: string }).version
          }
        }
      } catch {
        // Deployment facts remain available when the public registry is unreachable.
      }

      if (generation !== this.loadGeneration || latestVersion === undefined) return
      this.store.update((state) => {
        state.releaseStatus = releaseStatus(health.version, latestVersion)
        state.latestVersion = latestVersion
      })
    } catch (error) {
      if (generation !== this.loadGeneration) return
      this.store.update((state) => {
        state.status = 'error'
        state.error = messageOf(error)
        delete state.health
      })
    }
  }

  async setApprovalMode(mode: ApprovalMode): Promise<void> {
    this.approvalGeneration++
    this.store.update((state) => {
      state.approvalSaving = true
      state.approvalSaved = false
      delete state.approvalError
    })
    try {
      const response = await this.io.fetch('/api/approval-mode', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      this.store.update((state) => {
        state.approvalMode = mode
        state.approvalSaving = false
        state.approvalSaved = true
      })
    } catch (error) {
      this.store.update((state) => {
        state.approvalSaving = false
        state.approvalError = messageOf(error)
      })
    }
  }

  async refreshMcpServers(): Promise<void> {
    const mcpGen = ++this.mcpGeneration
    try {
      const response = await this.io.fetch('/api/mcp-servers', { credentials: 'same-origin' })
      if (mcpGen === this.mcpGeneration && response.ok) {
        const data = await response.json() as { servers?: McpServerEntry[]; restartRequired?: boolean }
        if (mcpGen === this.mcpGeneration && Array.isArray(data.servers)) {
          this.store.update((state) => {
            state.mcpServers = data.servers as McpServerEntry[]
            state.mcpLoaded = true
            state.mcpRestartNeeded = data.restartRequired === true
          })
        }
      }
    } catch { /* ignore */ }
  }

  async saveMcpServers(servers: McpServerEntry[]): Promise<boolean> {
    this.mcpGeneration++
    this.store.update((state) => { state.mcpSaving = true; delete state.mcpError })
    try {
      const response = await this.io.fetch('/api/mcp-servers', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ servers }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error ?? `HTTP ${String(response.status)}`)
      }
      const result = await response.json() as { servers?: McpServerEntry[]; restartRequired?: boolean }
      const saved = result.servers ?? servers
      this.store.update((state) => {
        state.mcpServers = saved
      })
      const probeErrors: string[] = []
      for (const s of saved) {
        if (s.auth?.type === 'oauth') continue
        try {
          const probeRes = await this.io.fetch(`/api/mcp-servers/${encodeURIComponent(s.serverName)}/probe`, {
            method: 'POST', credentials: 'same-origin',
          })
          if (!probeRes.ok) {
            const data = await probeRes.json().catch(() => ({})) as { error?: string }
            probeErrors.push(`${s.serverName}: ${data.error ?? 'probe failed'}`)
          }
        } catch {
          probeErrors.push(`${s.serverName}: network error`)
        }
      }
      this.store.update((state) => {
        state.mcpSaving = false
        state.mcpRestartNeeded = result.restartRequired === true
        if (probeErrors.length > 0) {
          state.mcpError = probeErrors.join('; ')
        }
      })
      return true
    } catch (error) {
      this.store.update((state) => {
        state.mcpSaving = false
        state.mcpError = messageOf(error)
      })
      return false
    }
  }

  async saveMcpToken(serverName: string, token: string): Promise<boolean> {
    try {
      const response = await this.io.fetch(`/api/mcp-servers/${encodeURIComponent(serverName)}/token`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!response.ok) return false
      // Probe the server now that the token is available, then refresh state
      await this.io.fetch(`/api/mcp-servers/${encodeURIComponent(serverName)}/probe`, {
        method: 'POST', credentials: 'same-origin',
      }).catch(() => {})
      await this.refreshMcpServers()
      return true
    } catch {
      return false
    }
  }

  async startOAuthConnect(serverName: string, serverUrl: string): Promise<string | undefined> {
    const redirectUri = `${globalThis.location?.origin ?? ''}/api/mcp/oauth/callback`
    try {
      const response = await this.io.fetch('/api/mcp/oauth/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serverName, serverUrl, redirectUri }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string }
        this.store.update((state) => { state.mcpError = data.error ?? 'OAuth start failed' })
        return undefined
      }
      const result = await response.json() as { authorizationUrl?: string }
      return result.authorizationUrl
    } catch (error) {
      this.store.update((state) => { state.mcpError = messageOf(error) })
      return undefined
    }
  }

  async completeOAuthConnect(code: string, state: string): Promise<boolean> {
    try {
      const response = await this.io.fetch('/api/mcp/oauth/complete', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, state }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string }
        this.store.update((state) => { state.mcpError = data.error ?? 'OAuth complete failed' })
        return false
      }
      return true
    } catch {
      return false
    }
  }

  async clearMcpToken(serverName: string): Promise<void> {
    await this.io.fetch(`/api/mcp-servers/${encodeURIComponent(serverName)}/token`, {
      method: 'DELETE', credentials: 'same-origin',
    }).catch(() => {})
  }

  /** Copy the matching channel upgrade command without affecting deployment state. */
  async restartRuntime(): Promise<void> {
    await this.io.fetch('/api/restart', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
    this.io.navigate(globalThis.location?.pathname ?? '/')
  }

  async copyUpgrade(): Promise<void> {
    try {
      const version = this.store.getSnapshot().health?.version ?? '0.0.0'
      await this.io.copy(upgradeCommand(version))
      this.store.update((state) => {
        state.copied = true
        delete state.copyError
      })
    } catch (error) {
      this.store.update((state) => {
        state.copied = false
        state.copyError = messageOf(error)
      })
    }
  }

  /** Clear the browser owner session without affecting deployment-health state. */
  async signOut(): Promise<void> {
    this.store.update((state) => {
      state.signingOut = true
      delete state.signOutError
    })
    try {
      const response = await this.io.fetch('/api/auth/logout', {
        method: 'POST', credentials: 'same-origin', redirect: 'manual',
      })
      if (!response.ok && response.status !== 0 && response.status !== 303) {
        throw new Error(`HTTP ${String(response.status)}`)
      }
      this.io.navigate('/login')
    } catch (error) {
      this.store.update((state) => {
        state.signingOut = false
        state.signOutError = messageOf(error)
      })
    }
  }
}
