import * as Dialog from '@radix-ui/react-dialog'
import { useId, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface ModalProps {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}

/**
 * Radix Dialog does the parts that are genuinely hard to get right by hand and
 * trivial to get subtly wrong: the focus trap (and returning focus to whatever
 * opened the dialog), Escape, `aria-modal` plus inert-ing the rest of the page
 * for screen readers, and the scroll lock that keeps the background from
 * scrolling under the overlay on iOS.
 *
 * What is added here is only the shell: sizing, the surface, and the explicit
 * id wiring. Radix generates ids for Title/Description automatically, but they
 * are spelled out because `description` is optional — when it is absent the
 * `aria-describedby` attribute must be *absent*, not pointing at an empty node,
 * or a screen reader announces the dialog with a dangling description.
 */
const SIZES: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-[420px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[760px]',
}

export function Modal({ open, onOpenChange, title, description, children, footer, size = 'md' }: ModalProps) {
  const baseId = useId()
  const titleId = `${baseId}-title`
  const descriptionId = `${baseId}-description`

  /**
   * Radix restores focus to whatever opened the dialog automatically — but
   * only when Radix itself owns the trigger (`Dialog.Trigger`). Every dialog
   * in this app is opened from state the CALLER owns instead — an
   * `open`/`onOpenChange` pair flipped by a plain button (e.g. `setAssignOpen
   * (true)` in `AssigneeList`) — so there is no `Dialog.Trigger` for Radix to
   * remember. Worse, `Dialog.Content`'s own `onCloseAutoFocus` unconditionally
   * calls `event.preventDefault()` before trying that (empty) trigger ref,
   * which also suppresses `FocusScope`'s built-in fallback of returning focus
   * to whatever was focused before it mounted. Net effect: closing any dialog
   * — Escape, the X button, or an outside click — drops focus to `<body>`,
   * stranding a keyboard-only user.
   *
   * Fixed once, here, so every dialog built on `Modal` inherits it: whatever
   * has focus is captured the instant `open` turns true — read during render,
   * before `FocusScope` mounts and moves focus into the dialog, the only
   * point `document.activeElement` is guaranteed to still be the trigger —
   * and handed back via `onCloseAutoFocus`, which fires once per close no
   * matter which of the three paths caused it, superseding Radix's own
   * (trigger-less) attempt.
   */
  const wasOpen = useRef(open)
  const triggerRef = useRef<HTMLElement | null>(null)
  if (open && !wasOpen.current) {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  wasOpen.current = open

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-40 bg-[color-mix(in_srgb,var(--color-ink-900)_45%,transparent)]"
          data-testid="modal-overlay"
        />

        {/* Elevation is used sparingly in this product, but a modal genuinely
            floats above the page — the shadow is what says "the thing behind is
            still there and you will come back to it". */}
        <Dialog.Content
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            triggerRef.current?.focus()
          }}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-3rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col',
            'rounded-[var(--radius-lg)] border border-[var(--color-hairline)] bg-[var(--color-surface)]',
            'shadow-[0_24px_60px_-12px_rgba(16,24,40,0.28)]',
            SIZES[size],
          )}
        >
          <div className="flex items-start gap-4 px-5 pt-5 pb-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title
                id={titleId}
                className="font-[family-name:var(--font-display)] text-[16px] font-semibold tracking-tight text-[var(--color-ink-900)]"
              >
                {title}
              </Dialog.Title>
              {description && (
                <Dialog.Description id={descriptionId} className="mt-1.5 text-[13px] text-[var(--color-ink-500)]">
                  {description}
                </Dialog.Description>
              )}
            </div>

            <Dialog.Close
              aria-label="Close"
              className="-mt-1 -mr-1 grid size-7 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--color-ink-400)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink-900)]"
            >
              <svg className="size-4" viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">
                <path d="m3.5 3.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </Dialog.Close>
          </div>

          {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>}

          {footer && (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--color-hairline)] bg-[var(--color-surface-sunken)] px-5 py-3.5">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
