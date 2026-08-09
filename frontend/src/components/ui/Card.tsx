import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * A panel: hairline border on white, no shadow. Nothing here floats, so
 * nothing here casts a shadow — separation is the border's job.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { title, actions, children, className, ...props },
  ref,
) {
  const hasHeader = title != null || actions != null

  return (
    <div
      ref={ref}
      className={cn(
        'rounded-[var(--radius-lg)] border border-[var(--color-hairline)] bg-[var(--color-surface)]',
        className,
      )}
      {...props}
    >
      {hasHeader && (
        <div className="flex min-h-12 items-center justify-between gap-3 border-b border-[var(--color-hairline)] px-4 py-3">
          {title != null && (
            <h2 className="font-[family-name:var(--font-display)] text-[15px] font-medium tracking-tight text-[var(--color-ink-900)]">
              {title}
            </h2>
          )}
          {actions != null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  )
})
