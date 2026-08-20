import { compareVersions, validate } from 'compare-versions'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Repeatable command for upgrading an existing Edge deployment. */
const DSH_EDGE_UPGRADE_COMMAND = 'pnpm dlx dsh-edge@latest upgrade'

/** Public release history for the Edge distribution. */
export const DSH_EDGE_RELEASES_URL = 'https://github.com/pawaca/dsh-edge/releases'

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

/** Browser-owned state for the Edge settings section. */
export interface EdgeSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  health?: EdgeHealth
  latestVersion?: string
  releaseStatus?: 'development' | 'latest' | 'update-available' | 'unavailable'
  error?: string
  copied: boolean
  copyError?: string
  signingOut: boolean
  signOutError?: string
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
  })
  private loadGeneration = 0

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
      this.store.update((state) => {
        state.status = 'ready'
        state.health = health
        state.releaseStatus = releaseStatus(health.version)
        delete state.latestVersion
        delete state.error
      })

      let latestVersion: string | undefined
      try {
        const releaseResponse = await this.io.fetch('https://registry.npmjs.org/dsh-edge/latest', {
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

  /** Copy the stable upgrade command without affecting health or owner-session state. */
  async copyUpgrade(): Promise<void> {
    try {
      await this.io.copy(DSH_EDGE_UPGRADE_COMMAND)
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
