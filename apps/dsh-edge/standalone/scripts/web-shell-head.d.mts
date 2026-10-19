/** Inline script body injected at the top of the assembled Web shell's `<head>`. */
export const WEB_SHELL_HEAD_SCRIPT: string

/** Pattern the standalone verifier uses to prove the shell declares `__DSH_TRANSPORT__.ownsHost`. */
export const OWNER_HOST_DECLARATION: RegExp

/** Pattern the standalone verifier uses to prove the shell declares the owner's access baseline (`__DSH_REMOTE_ACCESS__`). */
export const OWNER_ACCESS_DECLARATION: RegExp

/** Inject the head script into an assembled index document. */
export function injectOwnerSessionGuard(html: string): string

/** Move the document's `<meta charset>` to the start of `<head>`, within the first 1024 bytes a browser reads it from. */
export function hoistCharsetMeta(html: string): string
