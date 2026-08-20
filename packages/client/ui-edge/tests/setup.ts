import { createElement, type ReactNode } from 'react'
import { vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-runtime/client', () => ({
  createSnapshotStore<T extends object>(initial: T) {
    let state = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      update(recipe: (draft: T) => void) {
        state = { ...state }
        recipe(state)
        for (const listener of listeners) listener()
      },
    }
  },
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button({ children, variant: _variant, size: _size, ...props }: {
    children?: ReactNode
    variant?: string
    size?: string
  }) {
    return createElement('button', props, children)
  },
  StateDot({ state }: { state: string }) {
    return createElement('span', { 'data-state': state })
  },
  writeClipboard: vi.fn(() => Promise.resolve(true)),
}))
