/** Inline script body injected at the top of the assembled Web shell's `<head>`. */
export const WEB_SHELL_HEAD_SCRIPT: string

/** Pattern the standalone verifier uses to prove the shell declares `__DSH_TRANSPORT__.ownsHost`. */
export const OWNER_HOST_DECLARATION: RegExp

/** Inject the head script into an assembled index document. */
export function injectOwnerSessionGuard(html: string): string
