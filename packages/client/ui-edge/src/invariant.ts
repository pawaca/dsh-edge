/** Package-owned invariant companion for the Edge settings surface. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-edge-client-ui'

export const name = 'client-ui-edge-invariant'
export const inject = ['invariants']
/** No runtime invariant: this browser-only settings projection owns no host event stream or mutable host state. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
