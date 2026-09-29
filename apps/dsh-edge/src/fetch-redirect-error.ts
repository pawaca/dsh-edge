/**
 * Workers `fetch()` rejects `redirect: 'error'`, the mode upstream providers
 * use to refuse redirects. Serve it as the Fetch standard defines it: request
 * without following, and fail as a network error when a redirect arrives.
 * Imported first by the Worker entry so every upstream caller sees it.
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const platformFetch = globalThis.fetch.bind(globalThis)

globalThis.fetch = async (input, init) => {
  if (init?.redirect !== 'error') return platformFetch(input, init)
  const response = await platformFetch(input, { ...init, redirect: 'manual' })
  if (REDIRECT_STATUSES.has(response.status) && response.headers.has('location')) {
    await response.body?.cancel()
    throw new TypeError('fetch failed: the response redirected and the request redirect mode is "error"')
  }
  return response
}

export {}
