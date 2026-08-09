import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
}

/* Primary is ink, not blue. Blue carries one meaning in this product —
   coverage — and a blue Save would spend that meaning on furniture. */
const VARIANTS: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    'bg-[var(--color-ink-900)] text-white hover:bg-[var(--color-ink-700)] active:bg-[var(--color-ink-900)]',
  secondary:
    'bg-[var(--color-surface)] text-[var(--color-ink-900)] border border-[var(--color-hairline)] hover:bg-[var(--color-surface-sunken)]',
  ghost:
    'bg-transparent text-[var(--color-ink-500)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink-900)]',
  danger: 'bg-[var(--color-conflict)] text-white hover:opacity-90',
}

const SIZES: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-3.5 text-[14px]',
}

/* Gap lives on the inner label rather than the button, because the button's
   only child is that label — icons passed as children space themselves here. */
const GAPS: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'gap-1.5',
  md: 'gap-2',
}

function Spinner() {
  return (
    <svg className="size-4 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, disabled, className, children, ...props },
  ref,
) {
  const isDisabled = disabled || loading

  return (
    <button
      ref={ref}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        'relative inline-flex items-center justify-center rounded-[var(--radius-md)] font-medium whitespace-nowrap transition-colors',
        SIZES[size],
        VARIANTS[variant],
        isDisabled && 'pointer-events-none',
        loading && 'cursor-progress',
        disabled && !loading && 'opacity-45',
        className,
      )}
      {...props}
    >
      {/* The label keeps its box while loading — opacity, not display, so the
          button cannot change width mid-save and shove the toolbar around.
          opacity also leaves the label in the accessibility tree, which
          `hidden`/`invisible` would not: the button keeps its name. */}
      <span className={cn('inline-flex items-center', GAPS[size], loading && 'opacity-0')}>{children}</span>
      {loading && (
        <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
          <Spinner />
        </span>
      )}
    </button>
  )
})
