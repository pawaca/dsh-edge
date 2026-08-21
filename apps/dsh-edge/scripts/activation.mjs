import { setTimeout as sleep } from 'node:timers/promises'
import edgePackage from '../package.json' with { type: 'json' }

export const ACTIVATION_WAIT_MS = 45_000
export const ACTIVATION_REQUEST_TIMEOUT_MS = 4_000
export const ACTIVATION_RETRY_MS = 1_500

const MAX_HEALTH_BYTES = 64 * 1024

/** Observe when Cloudflare serves the exact Worker release without making it an install gate. */
export async function observePublicActivation({
  publicUrl,
  mode,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  requestTimeoutMs = ACTIVATION_REQUEST_TIMEOUT_MS,
  retryMs = ACTIVATION_RETRY_MS,
  signal,
  sleepImpl = sleep,
  waitMs = ACTIVATION_WAIT_MS,
} = {}) {
  if (mode !== 'direct' && mode !== 'isolated') throw new Error('A runtime mode is required.')
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('Activation wait must be non-negative.')
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('Activation request timeout must be positive.')
  }
  if (!Number.isFinite(retryMs) || retryMs <= 0) throw new Error('Activation retry must be positive.')
  if (typeof fetchImpl !== 'function') throw new Error('Activation observation requires fetch.')

  const healthUrl = publicHealthUrl(publicUrl)
  const expected = {
    deploymentId: `dsh-edge@${edgePackage.version}/${mode}`,
    shell: mode === 'direct' ? 'just-bash-direct' : 'just-bash-isolated',
  }
  const startedAt = now()
  const deadline = startedAt + waitMs
  let attempts = 0

  while (true) {
    signal?.throwIfAborted()
    if (attempts > 0 && now() >= deadline) {
      return activationResult('pending', attempts, startedAt, now())
    }
    attempts += 1
    const requestTimeout = AbortSignal.timeout(requestTimeoutMs)
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
          return activationResult('ready', attempts, startedAt, now())
        }
      } else {
        await response.body?.cancel()
      }
    } catch {
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
