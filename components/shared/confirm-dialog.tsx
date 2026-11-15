'use client'

import { useEffect, useId, useRef } from 'react'

type Props = {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A yes/no question in a native <dialog>, for actions that interrupt a running
 * agent. Escape and Cancel both leave things as they were.
 */
export function ConfirmDialog({ open, title, description, confirmLabel, onConfirm, onCancel }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (open) dialogRef.current?.showModal()
    else dialogRef.current?.close()
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      onClose={() => { if (open) onCancel() }}
      aria-labelledby={open ? titleId : undefined}
      className="backdrop:bg-black/50 rounded-xl border border-[var(--border)] bg-[var(--background)] p-6 w-full max-w-md shadow-xl"
    >
      {open && (
        <div className="space-y-4">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
          <div className="flex justify-end gap-2">
            <button
              autoFocus
              onClick={onCancel}
              className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] hover:bg-muted"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      )}
    </dialog>
  )
}
