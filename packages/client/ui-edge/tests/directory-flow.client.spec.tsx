// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EdgeDirectoryFlow } from '../src/client/EdgeDirectoryFlow.tsx'

afterEach(cleanup)

function renderFlow(overrides: Partial<Parameters<typeof EdgeDirectoryFlow>[0]> = {}) {
  const props = {
    open: true,
    busy: false,
    onPicked: vi.fn(),
    onCancel: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
  const result = render(<EdgeDirectoryFlow {...props} />)
  return { ...result, props }
}

describe('EdgeDirectoryFlow', () => {
  it('renders nothing when closed', () => {
    const { container } = renderFlow({ open: false })
    expect(container.innerHTML).toBe('')
  })

  it('renders the popover with input when open', () => {
    renderFlow()
    expect(screen.getByText('New Workspace')).toBeDefined()
    expect(screen.getByPlaceholderText('project-name')).toBeDefined()
    expect(screen.getByText('Create')).toBeDefined()
  })

  it('disables create button when input is empty', () => {
    renderFlow()
    const button = screen.getByText('Create') as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('enables create button with valid input', () => {
    renderFlow()
    const input = screen.getByPlaceholderText('project-name')
    fireEvent.change(input, { target: { value: 'my-project' } })
    const button = screen.getByText('Create') as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })

  it('calls onPicked with full path on submit', () => {
    const { props } = renderFlow()
    const input = screen.getByPlaceholderText('project-name')
    fireEvent.change(input, { target: { value: 'my-project' } })
    fireEvent.click(screen.getByText('Create'))
    expect(props.onPicked).toHaveBeenCalledWith('/workspace/my-project')
  })

  it('calls onPicked on Enter key', () => {
    const { props } = renderFlow()
    const input = screen.getByPlaceholderText('project-name')
    fireEvent.change(input, { target: { value: 'test-app' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onPicked).toHaveBeenCalledWith('/workspace/test-app')
  })

  it('calls onCancel on Escape key', () => {
    const { props } = renderFlow()
    const input = screen.getByPlaceholderText('project-name')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(props.onCancel).toHaveBeenCalledOnce()
  })

  it('shows error for path traversal', () => {
    renderFlow()
    const input = screen.getByPlaceholderText('project-name')
    fireEvent.change(input, { target: { value: '..' } })
    expect(screen.getByText('Invalid directory name')).toBeDefined()
    const button = screen.getByText('Create') as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('shows error for slash in name', () => {
    renderFlow()
    const input = screen.getByPlaceholderText('project-name')
    fireEvent.change(input, { target: { value: 'a/b' } })
    expect(screen.getByText('Name cannot contain /')).toBeDefined()
  })

  it('does not submit on Enter with invalid input', () => {
    const { props } = renderFlow()
    const input = screen.getByPlaceholderText('project-name')
    fireEvent.change(input, { target: { value: '..' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onPicked).not.toHaveBeenCalled()
  })

  it('disables input and button when busy', () => {
    renderFlow({ busy: true })
    const input = screen.getByPlaceholderText('project-name') as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect(screen.getByText('Creating…')).toBeDefined()
  })
})
