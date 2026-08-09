import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: string
  description?: string
  action?: ReactNode
}

/**
 * Nothing here yet — which is a normal state, not a problem. The warm surface
 * token separates it from the error surfaces without raising an alarm.
 */
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { title, description, action, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'flex flex-col items-center rounded-[var(--radius-lg)] border border-[var(--color-hairline)] bg-[var(--color-surface-warm)] px-6 py-10 text-center',
        className,
      )}
      {...props}
    >
      <p className="font-[family-name:var(--font-display)] text-[15px] font-medium tracking-tight text-[var(--color-ink-900)]">
        {title}
      </p>
      {description && (
        <p className="mt-1.5 max-w-[42ch] text-[13px] text-[var(--color-ink-500)]">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
})
