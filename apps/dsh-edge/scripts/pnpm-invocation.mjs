/**
 * Resolve a pnpm invocation across JavaScript-entry and standalone installs.
 * @param {string | undefined} pnpm Package-manager path supplied by pnpm.
 * @param {string[]} args Arguments to pass to pnpm.
 * @param {{ nodeExecutable?: string }} [options] Resolution inputs.
 * @returns {{ command: string, args: string[] }} Executable and arguments.
 */
export function resolvePnpmInvocation(pnpm, args, options = {}) {
  if (pnpm === undefined || pnpm === '') {
    throw new Error('Cannot run pnpm without a package-manager executable.')
  }

  const nodeExecutable = options.nodeExecutable ?? process.execPath
  if (/\.[cm]?js$/iu.test(pnpm)) {
    return {
      command: nodeExecutable,
      args: [pnpm, ...args],
    }
  }

  return {
    command: pnpm,
    args,
  }
}
