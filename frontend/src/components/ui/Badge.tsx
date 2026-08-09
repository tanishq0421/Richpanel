import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'brand' | 'conflict' | 'impact' | 'zero'
  children: ReactNode
}

/**
 * Each tone maps to exactly one semantic token, so a badge can never invent a
 * meaning the palette does not have.
 *
 * `zero` is the one worth spelling out: zero scheduled hours is information,
 * not a failure. It gets the grey token — never the conflict red — so a week
 * with an unstaffed day does not read as a broken week.
 */
const TONES: Record<NonNullable<BadgeProps['tone']>, string> = {
  neutral:
    'bg-[var(--color-surface-sunken)] text-[var(--color-ink-700)] ring-1 ring-[var(--color-hairline)] ring-inset',
  brand: 'bg-[var(--color-brand-100)] text-[var(--color-brand)]',
  conflict: 'bg-[var(--color-conflict-bg)] text-[var(--color-conflict)]',
  impact: 'bg-[var(--color-impact-bg)] text-[var(--color-impact)]',
  zero: 'bg-[var(--color-surface-sunken)] text-[var(--color-zero)] ring-1 ring-[var(--color-hairline)] ring-inset',
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = 'neutral', className, children, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-2 py-0.5 text-[11px] font-medium tracking-wide whitespace-nowrap',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
})
