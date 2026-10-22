export interface MockMcpServer {
  readonly url: string
  readonly port: number
  readonly tools: readonly unknown[]
  /** JSON-RPC methods received, in order. */
  readonly requests: string[]
  close(): Promise<void>
}

/** `tools: false` leaves the tools capability out, as a resources-only server does. */
export function startMockMcpServer(port?: number, options?: { resources?: boolean; tools?: boolean }): Promise<MockMcpServer>
