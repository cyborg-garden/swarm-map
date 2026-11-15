/**
 * ConfirmDialog: a yes/no question in a native <dialog>. Nothing runs until
 * the operator presses the confirm button; Cancel and Escape both back out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConfirmDialog } from './confirm-dialog'

beforeEach(() => {
  // jsdom: <dialog> modal methods are not implemented
  HTMLDialogElement.prototype.showModal = vi.fn()
  HTMLDialogElement.prototype.close = vi.fn()
})

function setup(open = true) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  const view = render(
    <ConfirmDialog open={open} title="Stop alpha?" description="It goes offline." confirmLabel="Stop" onConfirm={onConfirm} onCancel={onCancel} />,
  )
  return { onConfirm, onCancel, ...view }
}

describe('ConfirmDialog', () => {
  it('shows nothing and opens no modal while closed', () => {
    setup(false)
    expect(screen.queryByText('Stop alpha?')).toBeNull()
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled()
  })

  it('opens as a modal with the question', () => {
    setup()
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Stop alpha?')).toBeInTheDocument()
    expect(screen.getByText('It goes offline.')).toBeInTheDocument()
  })

  it('confirms only from the confirm button', () => {
    const { onConfirm, onCancel } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Stop', hidden: true }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cancels from the Cancel button and from Escape', () => {
    const { onConfirm, onCancel, container } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', hidden: true }))
    // Escape closes a modal <dialog>, which fires its close event.
    fireEvent(container.querySelector('dialog')!, new Event('close'))
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
