import * as SessionTurnOutline from '@deepseek-ai/dsh-session-turn-outline'

interface OutlineDefinition {
  init: () => unknown
  apply: (state: unknown, event: { type: string; seq: number; data: unknown }) => unknown
}

function outlineDefinition(): OutlineDefinition {
  let definition: OutlineDefinition | undefined
  SessionTurnOutline.apply({ sessionProjections: { register: (unit: OutlineDefinition) => { definition = unit } } } as never)
  if (definition === undefined) throw new Error('turn outline did not register its projection')
  return definition
}

/** Fold `turns` turns of long CJK prompts and replies, which upstream clips to full-length previews. */
export function worstCaseOutline(turns: number): unknown {
  const { init, apply } = outlineDefinition()
  const prompt = '请帮我检查这个会话里所有失败的命令并总结原因'.repeat(20)
  const reply = '已检查完毕，失败的原因主要是容器启动超时和依赖缺失，下面逐条说明'.repeat(20)
  let state = init()
  let seq = 0
  for (let turn = 1; turn <= turns; turn++) {
    state = apply(state, { type: 'turn/start', seq: ++seq, data: { turn } })
    state = apply(state, { type: 'user/message', seq: ++seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] } })
    state = apply(state, { type: 'assistant/message', seq: ++seq, data: { message: { content: [{ type: 'text', text: reply }] } } })
    state = apply(state, { type: 'turn/end', seq: ++seq, data: { turn } })
  }
  return state
}
