import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import css from './EdgeDirectoryFlow.module.css'

interface EdgeDirectoryFlowProps {
  open: boolean
  busy: boolean
  onPicked: (path: string) => void
  onCancel: () => void
  onError: (message: string) => void
}

const WORKSPACE_PREFIX = '/workspace/'

function validate(name: string): string | null {
  if (name.length === 0) return null
  if (name.includes('/')) return 'Name cannot contain /'
  if (name === '.' || name === '..') return 'Invalid directory name'
  if (name.includes('\0')) return 'Invalid characters'
  return ''
}

export function EdgeDirectoryFlow(props: EdgeDirectoryFlowProps): ReactNode {
  const { open, busy, onPicked, onCancel } = props
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setName('')
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
      onCancel()
    }
  }, [onCancel])

  useEffect(() => {
    if (!open) return
    document.addEventListener('mousedown', handleClickOutside, true)
    return () => document.removeEventListener('mousedown', handleClickOutside, true)
  }, [open, handleClickOutside])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onCancel()
    } else if (e.key === 'Enter') {
      const v = validate(name)
      if (v === '') onPicked(WORKSPACE_PREFIX + name)
    }
  }, [name, onPicked, onCancel])

  if (!open) return null

  const validation = validate(name)
  const isValid = validation === ''
  const isError = validation !== null && validation !== ''

  return (
    <div ref={popoverRef} className={css.popover}>
      <span className={css.title}>New Workspace</span>
      <div className={`${css.inputGroup}${isError ? ` ${css.error}` : ''}`}>
        <span className={css.prefix}>{WORKSPACE_PREFIX}</span>
        <input
          ref={inputRef}
          className={css.input}
          type="text"
          placeholder="project-name"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={busy}
        />
      </div>
      {isError && <span className={css.errorText}>{validation}</span>}
      {!isError && !isValid && <span className={css.hint}>Enter a project directory name</span>}
      {isValid && <span className={css.hint}>{WORKSPACE_PREFIX}{name}</span>}
      <button
        className={css.submitBtn}
        disabled={!isValid || busy}
        onClick={() => onPicked(WORKSPACE_PREFIX + name)}
      >
        {busy ? 'Creating…' : 'Create'}
      </button>
    </div>
  )
}
