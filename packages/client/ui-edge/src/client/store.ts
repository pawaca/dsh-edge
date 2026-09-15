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

export interface McpServerEntry {
  serverName: string
  url: string
  headers?: Record<string, string>
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
    mcpServers: [], mcpSaving: false, mcpRestartNeeded: false,
  })
  private loadGeneration = 0
  private approvalGeneration = 0

  constructor(private readonly io: EdgeSettingsIO) {}

  /** Load the current deployment projection without affecting owner-session state. */
  async load(): Promise<void> {
    const generation = ++this.loadGeneration
    this.store.update((state) => { state.status = 'loading'; delete state.error })
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

      try {
        const mcpResponse = await this.io.fetch('/api/mcp-servers', { credentials: 'same-origin' })
        if (generation === this.loadGeneration && mcpResponse.ok) {
          const data = await mcpResponse.json() as { servers?: McpServerEntry[] }
          if (Array.isArray(data.servers)) {
            this.store.update((state) => { state.mcpServers = data.servers as McpServerEntry[] })
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

  async saveMcpServers(servers: McpServerEntry[]): Promise<void> {
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
      this.store.update((state) => {
        state.mcpServers = result.servers ?? servers
        state.mcpSaving = false
        state.mcpRestartNeeded = result.restartRequired === true
      })
    } catch (error) {
      this.store.update((state) => {
        state.mcpSaving = false
        state.mcpError = messageOf(error)
      })
    }
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
