/** Cloudflare-specific runtime bindings exposed through upstream DSH tool seams. */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { EDGE_SHELL_OUTPUT_LIMIT_BYTES } from './direct-shell-protocol.ts'
import type { EdgeExecutionId } from './protocol.ts'
import type { EdgeRuntimeProviderDescriptor } from './runtime-provider.ts'

const JUST_BASH_SHELL = 'The shell is just-bash (not Linux) — native binaries and background processes are unavailable. '
const CONTAINER_SHELL = 'Commands start in just-bash, a fast lightweight shell for file and text work. '
  + 'A command that needs git, node, npm, python3, other native programs, or the network runs automatically '
  + 'in a Linux container (Debian); set linux: true on the bash call to force it. The container starts on '
  + 'demand and sleeps when idle, so its first command after a pause can take several seconds. Both shells '
  + 'share /workspace, the only place that persists; any other path is the container\'s own, so set linux: true '
  + 'to reach it. Each command runs to completion, so do not rely on background processes. '

const EDGE_SYSTEM_PROMPT_TOOLS = 'Each tool\'s detailed usage is in its own prompt section below.\n\n'
  + 'MCP tools: External tool servers may be connected via MCP. '
  + 'If tools are listed directly, call them by their full mcp__<serverName>__<toolName> name. '
  + 'If mcp_search and mcp_call are available, always discover tools with mcp_search first, then invoke with mcp_call using the exact toolName from search results.\n\n'
  + 'Background work: Use subagent to delegate independent tasks in parallel, '
  + 'and job tools to track their progress. '
  + 'Use schedule tools for durable reminders that survive session restarts.'

/** The persona prefix for a deployment whose bash layer runs on `shell`. */
export function edgeSystemPrompt(shell: EdgeRuntimeProviderDescriptor['shell']): string {
  return 'You are dsh-edge, a coding agent running in a Cloudflare Worker '
    + 'with a persistent /workspace directory. '
    + (shell === 'linux-container' ? CONTAINER_SHELL : JUST_BASH_SHELL)
    + EDGE_SYSTEM_PROMPT_TOOLS
}

/**
 * Deployment-owned guidance the upstream `dsh-plan-mode` plugin renders as the
 * `plan:policy` prompt section while a session is in plan mode. Plan mode is
 * guidance, not enforcement: every tool stays callable.
 */
export const EDGE_PLAN_MODE_SECTION = 'You are in plan mode. Explore the workspace and design before executing: '
  + 'read files, search, and reason, but do not write, edit, or run commands that change the workspace. '
  + 'When the plan is complete, present it through exit_plan_mode as markdown starting with a # heading; '
  + 'the user approves it or sends feedback to keep planning.'

export interface EdgeShellResult {
  executionId: EdgeExecutionId
  status: 'completed' | 'failed' | 'cancelled'
  timedOut: boolean
  exitCode: number
  stdout: string
  stderr: string
  outputTruncated: boolean
  /** Where a container deployment ran the command; absent without a container. */
  runtime?: 'light' | 'container'
  /** Time spent waiting for a container slot before the command started. */
  queuedMs?: number
  /** The lightweight shell could not run it and changed nothing, so it reran in the container. */
  retriedFromLight?: boolean
  /** The lightweight shell could not run it but changed the workspace, so it was not rerun. */
  lightShellMiss?: boolean
}

export interface EdgeShell {
  exec(command: string, options: {
    cwd: string
    timeoutMs?: number
    signal?: AbortSignal
    /** Run in the Linux container regardless of routing (container deployments only). */
    requestContainer?: boolean
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

  get(sessionId: SessionId): { shell: EdgeShell; cwd: string } | undefined {
    return this.shells.get(sessionId)
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
export function createEdgeBashTool(
  bindings: EdgeShellBindings,
  shell: EdgeRuntimeProviderDescriptor['shell'] = 'just-bash-direct',
): ToolDefinition {
  return defineTool({
    name: 'bash',
    description: (shell === 'linux-container'
      ? 'Execute a bash command against the persistent /workspace. It runs in the lightweight just-bash '
        + 'shell unless it needs git, node, npm, python3, other native programs, or the network, in which '
        + 'case it runs in the Linux container; set linux to true to force the container.'
      : 'Execute a just-bash command against the persistent /workspace virtual filesystem.')
      + ' Each call starts in the session working directory unless workdir is supplied.',
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
      ...shell === 'linux-container'
        ? {
            linux: {
              type: 'boolean' as const,
              description: 'Run in the Linux container even if the command looks like light shell work.',
            },
          }
        : {},
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
          runtime: { type: 'string', enum: ['light', 'container'] },
          queuedMs: { type: 'number' },
          retriedFromLight: { type: 'boolean' },
          lightShellMiss: { type: 'boolean' },
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
        ...(args as { linux?: boolean }).linux === true ? { requestContainer: true } : {},
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
  const queued = result.queuedMs !== undefined && result.queuedMs >= 1_000
    ? ` after waiting ${Math.round(result.queuedMs / 1_000)}s for a free slot`
    : ''
  const where = result.runtime === 'container'
    ? result.retriedFromLight === true
      ? `\n[the lightweight shell could not run this, so it reran in the Linux container${queued}]`
      : `\n[ran in the Linux container${queued}]`
    : result.lightShellMiss === true
      ? '\n[the lightweight shell could not run part of this after it had changed files; '
        + 'check the workspace, then rerun with linux: true to use the Linux container]'
      : ''
  return output + truncated + timedOut + suffix + where || '(no output)'
}
