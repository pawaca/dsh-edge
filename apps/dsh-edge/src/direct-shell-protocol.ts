/**
 * Output bytes the lightweight shell may produce before it stops a command.
 * just-bash returns a command's output whole rather than streaming it, so
 * this bounds that buffer in the shell's isolate (the Durable Object in Direct
 * mode); the model sees each stream's tail either way.
 */
export const LIGHT_SHELL_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** Standard shell-event result used when direct just-bash stops at its output budget. */
export const DIRECT_SHELL_OUTPUT_TRUNCATED = 'dsh-edge:direct-output-truncated'
