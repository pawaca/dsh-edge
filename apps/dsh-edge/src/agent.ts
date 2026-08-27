/** Cloudflare-specific runtime bindings exposed through upstream DSH tool seams. */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { EDGE_SHELL_OUTPUT_LIMIT_BYTES } from './direct-shell-protocol.ts'
import type { EdgeExecutionId } from './protocol.ts'

export const EDGE_SYSTEM_PROMPT = 'You are dsh-edge, a coding agent running in a Cloudflare Worker. '
  + 'Your persistent working directory is /workspace. Use the bash tool when '
  + 'you need to inspect or modify workspace files, then answer with the result. '
  + 'The shell is just-bash, not Linux: native binaries and background processes are unavailable.'

export interface EdgeShellResult {
  executionId: EdgeExecutionId
  status: 'completed' | 'failed' | 'cancelled'
  timedOut: boolean
  exitCode: number
  stdout: string
  stderr: string
  outputTruncated: boolean
}

export interface EdgeShell {
  exec(command: string, options: {
    cwd: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<EdgeShellResult>
}

/** Request-scoped Computer workspaces keyed by the upstream agent/session identity. */
export class EdgeShellBindings {
  private readonly shells = new Map<SessionId, { shell: EdgeShell; cwd: string }>()

  bind(sessionId: SessionId, shell: EdgeShell, cwd: string): () => void {
    if (this.shells.has(sessionId)) {
      throw new Error(`dsh-edge: shell is already bound for session "${sessionId}"`)
    }
    this.shells.set(sessionId, { shell, cwd })
    return () => {
      if (this.shells.get(sessionId)?.shell === shell) this.shells.delete(sessionId)
    }
  }

  require(sessionId: SessionId): { shell: EdgeShell; cwd: string } {
    const entry = this.shells.get(sessionId)
    if (entry === undefined) {
      throw new Error(`dsh-edge: no active Computer workspace for session "${sessionId}"`)
    }
    return entry
  }
}

/** Native DSH tool definition whose body is the Cloudflare Computer adapter. */
export function createEdgeBashTool(bindings: EdgeShellBindings): ToolDefinition {
  return defineTool({
    name: 'bash',
    description: 'Execute a just-bash command against the persistent /workspace virtual filesystem. Each call starts in the session working directory unless workdir is supplied.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'The shell command to execute.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'A short explanation of what the command does.',
      },
      workdir: {
        type: 'string',
        description: 'An absolute directory below /workspace.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional execution timeout in milliseconds.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          executionId: { type: 'string', required: true },
          status: {
            type: 'string',
            enum: ['completed', 'failed', 'cancelled'],
            required: true,
          },
          timedOut: { type: 'boolean', required: true },
          exitCode: { type: 'number', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          outputTruncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, result) => [{ type: 'text', text: formatExecution(result) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('dsh-edge: bash requires an initiating agent')
      const { shell, cwd } = bindings.require(agent.id)
      return shell.exec(args.command, {
        cwd: args.workdir ?? cwd,
        ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
        signal: exec.signal,
      })
    },
  })
}

function formatExecution(result: Omit<EdgeShellResult, 'executionId'>): string {
  const output = `${result.stdout}${result.stderr}`
  const truncated = result.outputTruncated
    ? `\n[output truncated after ${EDGE_SHELL_OUTPUT_LIMIT_BYTES} UTF-8 bytes]`
    : ''
  const timedOut = result.timedOut ? '\n[command timed out]' : ''
  const suffix = result.exitCode === 0 ? '' : `\n[exit code: ${result.exitCode}]`
  return output + truncated + timedOut + suffix || '(no output)'
}
