import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { EdgeSettingsKey } from './locales.ts'
import css from './EdgeDirectoryFlow.module.css'

export interface EdgeDirectoryFlowProps {
  open: boolean
  busy: boolean
  onPicked: (path: string) => void
  onCancel: () => void
  onError: (message: string) => void
  t: (key: EdgeSettingsKey) => string
}

const WORKSPACE_PREFIX = '/workspace/'

function validate(name: string, t: (key: EdgeSettingsKey) => string): string | null {
  if (name.length === 0) return null
  if (name.includes('/')) return t('workspaceNewErrorSlash')
  if (name === '.' || name === '..') return t('workspaceNewErrorTraversal')
  if (name.includes('\0')) return t('workspaceNewErrorChars')
  return ''
}

function findAnchorRect(slotEl: HTMLElement | null): DOMRect | null {
  let node = slotEl?.parentElement ?? null
  while (node !== null) {
    const btn = node.querySelector<HTMLElement>('button[aria-label]')
    if (btn !== null) return btn.getBoundingClientRect()
    node = node.parentElement
  }
  return null
}

export function EdgeDirectoryFlow(props: EdgeDirectoryFlowProps): ReactNode {
  const { open, busy, onPicked, onCancel, t } = props
  const [name, setName] = useState('')
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const slotRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    setName('')
    const rect = findAnchorRect(slotRef.current)
    setAnchor(rect !== null
      ? { top: rect.bottom + 6, left: rect.left }
      : { top: 60, left: 12 })
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onCancel()
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('mousedown', handleClickOutside, true)
    document.addEventListener('keydown', handleEscape, true)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true)
      document.removeEventListener('keydown', handleEscape, true)
    }
  }, [open, onCancel])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      const v = validate(name, t)
      if (v === '') onPicked(WORKSPACE_PREFIX + name)
    }
  }, [name, onPicked, t])

  if (!open || anchor === null) return <span ref={slotRef} />

  const validation = validate(name, t)
  const isValid = validation === ''
  const isError = validation !== null && validation !== ''

  return (
    <>
      <span ref={slotRef} />
      <div
        ref={popoverRef}
        className={css.popover}
        style={{ top: anchor.top, left: anchor.left }}
      >
        <span className={css.title}>{t('workspaceNewTitle')}</span>
        <div className={`${css.inputGroup}${isError ? ` ${css.error}` : ''}`}>
          <span className={css.prefix}>{WORKSPACE_PREFIX}</span>
          <input
            ref={inputRef}
            className={css.input}
            type="text"
            placeholder={t('workspaceNewPlaceholder')}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy}
          />
        </div>
        {isError && <span className={css.errorText}>{validation}</span>}
        {!isError && !isValid && <span className={css.hint}>{t('workspaceNewHint')}</span>}
        {isValid && <span className={css.hint}>{WORKSPACE_PREFIX}{name}</span>}
        <button
          className={css.submitBtn}
          disabled={!isValid || busy}
          onClick={() => onPicked(WORKSPACE_PREFIX + name)}
        >
          {busy ? t('workspaceNewCreating') : t('workspaceNewCreate')}
        </button>
      </div>
    </>
  )
}
