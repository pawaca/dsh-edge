/** Centralized MCP limits — all timeouts and size caps in one place. */

export const MCP_LIMITS = {
  probeTimeoutMs: 30_000,
  callTimeoutMs: 60_000,
  maxToolsPerServer: 128,
  maxCatalogPages: 10,
  maxCatalogBytes: 128 * 1024,
  maxDescriptionLength: 512,
  maxErrorMessageChars: 300,
  maxPublicNameLength: 64,
  maxInstructionsLength: 1024,
  metaToolThreshold: 20,
  /**
   * Bytes of one resources/* response body. The SDK parses a response whole,
   * and a read result (a blob kept for programmatic callers) is stored in the
   * session log, so a larger resource is refused while it streams in.
   */
  maxResourceResponseBytes: 1024 * 1024,
} as const
