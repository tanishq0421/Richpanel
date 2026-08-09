import { forwardRef, type HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export interface ConflictBannerProps extends HTMLAttributes<HTMLDivElement> {
  message: string
  onDismiss?: () => void
}

/**
 * A 409 from the scheduler: an overlapping shift, an already-assigned agent.
 * It is a business-rule rejection, so it lands inline next to the form that
 * caused it rather than in a toast that outlives the context.
 *
 * `role="alert"` because it appears in response to a submit the user just made
 * and must be announced without them hunting for it.
 */
export const ConflictBanner = forwardRef<HTMLDivElement, ConflictBannerProps>(function ConflictBanner(
  { message, onDismiss, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      role="alert"
      className={cn(
        'flex items-start gap-2.5 rounded-[var(--radius-md)] border-l-2 border-[var(--color-conflict)] bg-[var(--color-conflict-bg)] py-2.5 pr-2.5 pl-3',
        className,
      )}
      {...props}
    >
      <svg
        className="mt-px size-4 shrink-0 text-[var(--color-conflict)]"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M8 4.5v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="11.25" r="0.9" fill="currentColor" />
        <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.3" />
      </svg>

      <p className="flex-1 text-[13px] text-[var(--color-conflict)]">{message}</p>

      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mt-0.5 -mr-0.5 grid size-6 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--color-conflict)] transition-colors hover:bg-[var(--color-conflict)]/10"
        >
          <svg className="size-3.5" viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">
            <path d="m3.5 3.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  )
})
