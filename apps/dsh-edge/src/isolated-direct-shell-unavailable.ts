import type { BackendHandle, WorkspaceBackend } from '@cloudflare/computer'

/** Fail closed if an isolated build ever tries to connect without its Loader binding. */
export class DirectShellBackend implements WorkspaceBackend {
  readonly id = 'worker-shell'
  readonly type = 'unavailable-direct-shell'

  connect(): Promise<BackendHandle> {
    return Promise.reject(new Error('The isolated dsh-edge build requires the LOADER binding.'))
  }
}
