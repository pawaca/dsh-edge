/** Byte ceiling shared by shell execution, retention, and truncation rendering. */
export const EDGE_SHELL_OUTPUT_LIMIT_BYTES = 65_536

/** Standard shell-event result used when direct just-bash stops at its output budget. */
export const DIRECT_SHELL_OUTPUT_TRUNCATED = 'dsh-edge:direct-output-truncated'
