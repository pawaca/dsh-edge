/**
 * Head-of-document script the Edge injects into the assembled Web shell.
 *
 * Two concerns share one parser-blocking script so both apply before any
 * upstream client plugin evaluates:
 *
 * 1. Host ownership. Upstream `dsh-client-connection` treats the page as a
 *    trusted local client only when its hostname is loopback or when the
 *    embedding shell declares `globalThis.__DSH_TRANSPORT__.ownsHost`. The
 *    loopback tier gates host-persisted settings (plugin configuration cards,
 *    the settings document editor) and native path affordances. An Edge
 *    deployment always runs on a remote origin, but its only browser visitor
 *    is the cookie-authenticated single owner, so the shell declares
 *    ownership instead of letting the hostname heuristic classify the owner
 *    as an untrusted remote viewer. `fetch` and `openStream` stay unset so the
 *    default web carrier is used.
 * 2. Owner-session guard. An owner-authentication 401 on a same-origin API
 *    call sends the shell to `/login` instead of leaving a dead session.
 */

/** The inline script body, without `<script>` tags. */
export const WEB_SHELL_HEAD_SCRIPT = `(() => {
  const transport = globalThis.__DSH_TRANSPORT__
  globalThis.__DSH_TRANSPORT__ = { ...(transport ?? {}), ownsHost: true }
  const originalFetch = window.fetch.bind(window)
  let redirecting = false
  window.fetch = async (...args) => {
    const input = args[0]
    const href = input instanceof Request ? input.url : String(input)
    const target = new URL(href, window.location.href)
    const response = await originalFetch(...args)
    if (!redirecting
      && response.status === 401
      && response.headers.get('www-authenticate') === 'DshEdgeOwner'
      && target.origin === window.location.origin
      && target.pathname.startsWith('/api/')) {
      redirecting = true
      window.location.replace('/login')
    }
    return response
  }
})()`

/** Regex the standalone verifier uses to prove the assembled shell declares host ownership. */
export const OWNER_HOST_DECLARATION = /globalThis\.__DSH_TRANSPORT__ = \{ \.\.\.\(transport \?\? \{\}\), ownsHost: true \}/u

/**
 * Inject the head script at the top of `<head>` (or before everything when the
 * document has no head tag).
 * @param {string} html - the assembled index document.
 * @returns {string} the document with the script injected.
 */
export function injectOwnerSessionGuard(html) {
  const script = `<script>${WEB_SHELL_HEAD_SCRIPT}</script>`
  const head = html.indexOf('<head>')
  return head === -1
    ? `${script}${html}`
    : `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
}
