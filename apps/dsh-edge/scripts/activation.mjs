import { setTimeout as sleep } from 'node:timers/promises'
import edgePackage from '../package.json' with { type: 'json' }
import { isRuntimeMode, RUNTIME_MODES } from './runtime-providers.mjs'

export const ACTIVATION_WAIT_MS = 45_000
export const ACTIVATION_REQUEST_TIMEOUT_MS = 4_000
export const ACTIVATION_RETRY_MS = 1_500

const MAX_HEALTH_BYTES = 64 * 1024

/** Verify the exact uploaded release and its authenticated runtime before reporting ready. */
export async function observePublicActivation({
  publicUrl,
  mode,
  ownerSecret,
  versionId,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  requestTimeoutMs = ACTIVATION_REQUEST_TIMEOUT_MS,
  retryMs = ACTIVATION_RETRY_MS,
  signal,
  sleepImpl = sleep,
  waitMs = ACTIVATION_WAIT_MS,
} = {}) {
  if (!isRuntimeMode(mode)) throw new Error('A runtime mode is required.')
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('Activation wait must be non-negative.')
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('Activation request timeout must be positive.')
  }
  if (!Number.isFinite(retryMs) || retryMs <= 0) throw new Error('Activation retry must be positive.')
  if (typeof fetchImpl !== 'function') throw new Error('Activation observation requires fetch.')

  const healthUrl = publicHealthUrl(publicUrl)
  const expected = {
    workerVersionId: versionId,
    deploymentId: `dsh-edge@${edgePackage.version}/${mode}`,
    shell: RUNTIME_MODES[mode].expectedShell,
  }
  const startedAt = now()
  const deadline = startedAt + waitMs
  let attempts = 0

  while (true) {
    signal?.throwIfAborted()
    const requestBudget = deadline - now()
    if (requestBudget <= 0) {
      return activationResult('pending', attempts, startedAt, now())
    }
    attempts += 1
    const requestTimeout = AbortSignal.timeout(Math.min(requestTimeoutMs, requestBudget))
    const requestSignal = signal === undefined
      ? requestTimeout
      : AbortSignal.any([signal, requestTimeout])
    try {
      const response = await fetchImpl(healthUrl, {
        headers: {
          accept: 'application/json',
          'cache-control': 'no-cache',
        },
        redirect: 'manual',
        signal: requestSignal,
      })
      if (response.ok) {
        const health = await readBoundedJson(response, MAX_HEALTH_BYTES)
        if (isExpectedHealth(health, expected)) {
          if (typeof ownerSecret !== 'string' || Buffer.byteLength(ownerSecret, 'utf8') < 32 || Buffer.byteLength(ownerSecret, 'utf8') > 512) {
            throw new RuntimeActivationError('Runtime verification requires the owner access key.')
          }
          if (await verifyRuntime({ publicUrl, ownerSecret, fetchImpl, signal: requestSignal, expected })) {
            return activationResult('ready', attempts, startedAt, now())
          }
        }
      } else {
        await response.body?.cancel()
      }
    } catch (error) {
      if (error instanceof RuntimeActivationError) throw error
      if (signal?.aborted) signal.throwIfAborted()
      // DNS, routing, challenge, timeout, and placeholder responses are all
      // transient observations until the bounded wait expires.
    }

    const remaining = deadline - now()
    if (remaining <= 0) return activationResult('pending', attempts, startedAt, now())
    await sleepImpl(Math.min(retryMs, remaining), undefined, { signal })
  }
}

export function isExpectedHealth(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return value.ok === true
    && value.service === 'dsh-edge'
    && value.status === 'ready'
    && value.storage === 'durable-object-sqlite-vfs'
    && value.deploymentId === expected.deploymentId
    && value.shell === expected.shell
    && value.version === edgePackage.version
    && typeof expected.workerVersionId === 'string' && expected.workerVersionId.length > 0
    && value.workerVersionId === expected.workerVersionId
}

function publicHealthUrl(publicUrl) {
  const url = new URL(publicUrl)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || !url.hostname.endsWith('.workers.dev')
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('Activation observation requires a public workers.dev origin.')
  }
  url.pathname = '/api/health'
  return url.href
}

async function readBoundedJson(response, maxBytes) {
  if (response.body === null) return undefined
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let source = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        return undefined
      }
      source += decoder.decode(value, { stream: true })
    }
    source += decoder.decode()
    return JSON.parse(source)
  } catch {
    return undefined
  } finally {
    reader.releaseLock()
  }
}

function activationResult(status, attempts, startedAt, finishedAt) {
  return {
    attempts,
    elapsedMs: Math.max(0, finishedAt - startedAt),
    status,
  }
}

/** An upload succeeded, but its application is definitively not ready. */
export class RuntimeActivationError extends Error {}

async function verifyRuntime({ publicUrl, ownerSecret, fetchImpl, signal, expected }) {
  // Login and readiness use the same validated origin. Never follow redirects
  // with owner credentials, and keep the short-lived probe cookie in memory.
  const login = await fetchImpl(new URL('/api/auth/login', publicUrl).href, {
    method: 'POST', redirect: 'manual', signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: new URL(publicUrl).origin },
    body: new URLSearchParams({ accessKey: ownerSecret }).toString(),
  })
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  await login.body?.cancel()
  // A same-version deployment may still serve the previous owner key during propagation.
  if (login.status === 401) return false
  if (login.status !== 303 || !/^__Host-dsh_edge_owner=v1\.[0-9]+\.[A-Za-z0-9_-]+$/u.test(cookie ?? '')) return false
  const response = await fetchImpl(new URL('/api/ready', publicUrl).href, {
    redirect: 'manual', signal,
    headers: { accept: 'application/json', 'cache-control': 'no-cache', cookie },
  })
  const state = await readBoundedJson(response, MAX_HEALTH_BYTES)
  if (response.status === 503 && state?.code === 'runtime-initialization-failed'
    && state.workerVersionId === expected.workerVersionId) {
    throw new RuntimeActivationError('Worker uploaded, but session or workspace initialization failed. Upgrade is not ready. Do not delete stored data; install a compatible release. No automatic rollback was attempted.')
  }
  return response.ok && state?.runtime === true && isExpectedHealth(state, expected)
}
