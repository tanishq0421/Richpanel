import { forwardRef, type HTMLAttributes } from 'react'
import { Button } from '@/components/ui/Button'
import { userMessage } from '@/helpers/errors'
import { cn } from '@/lib/cn'

export interface ErrorStateProps extends HTMLAttributes<HTMLDivElement> {
  error: unknown
  onRetry?: () => void
}

/**
 * The only place a failed query is rendered. It never prints the raw error:
 * `userMessage` is the single translation from developer-accurate to
 * manager-actionable, so the same 409 reads identically everywhere.
 *
 * Retry appears only when the caller passes a handler — offering "Try again"
 * for a 404 invites the user to fail twice.
 */
export const ErrorState = forwardRef<HTMLDivElement, ErrorStateProps>(function ErrorState(
  { error, onRetry, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      role="alert"
      className={cn(
        'flex flex-col items-center rounded-[var(--radius-lg)] border border-[var(--color-hairline)] bg-[var(--color-surface)] px-6 py-10 text-center',
        className,
      )}
      {...props}
    >
      <span
        className="grid size-8 place-items-center rounded-[var(--radius-pill)] bg-[var(--color-conflict-bg)] text-[var(--color-conflict)]"
        aria-hidden="true"
      >
        <svg className="size-4" viewBox="0 0 16 16" fill="none" focusable="false">
          <path d="M8 4.5v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="11.25" r="0.9" fill="currentColor" />
        </svg>
      </span>

      <p className="mt-3 max-w-[46ch] text-[14px] text-[var(--color-ink-700)]">{userMessage(error)}</p>

      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
})
