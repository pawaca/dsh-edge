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
} as const
