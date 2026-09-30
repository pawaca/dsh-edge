/**
 * Message sources upstream declares in modules its package roots do not
 * re-export. The runtime already produces them; these declarations only make
 * them visible to Edge code that reads or creates such messages.
 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** `@deepseek-ai/dsh-agent-loop/runtime-context`: the loop's dynamic context snapshot. */
    'runtime-context': { kind: 'runtime-context' } & ContextFormed
    /** `@deepseek-ai/dsh-schedule` runtime: a delivered reminder. */
    'schedule': { kind: 'schedule' } & ContextFormed
  }
}
