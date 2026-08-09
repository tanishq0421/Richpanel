import { forwardRef, useId, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export interface SelectOption {
  value: string | number
  label: string
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  options: SelectOption[]
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, options, id, className, 'aria-describedby': describedBy, ...props },
  ref,
) {
  const generatedId = useId()
  const selectId = id ?? generatedId
  const messageId = `${selectId}-message`
  const description = [error ? messageId : null, describedBy].filter(Boolean).join(' ') || undefined

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label
          htmlFor={selectId}
          className="text-[11px] font-medium tracking-wide text-[var(--color-ink-500)] uppercase"
        >
          {label}
        </label>
      )}

      {/* The native control is kept — it is the only one that behaves correctly
          on touch and with a keyboard out of the box — but its chrome is
          replaced so it sits flush with Input in a form row. */}
      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          aria-invalid={error ? true : undefined}
          aria-describedby={description}
          className={cn(
            'h-9 w-full appearance-none rounded-[var(--radius-md)] border bg-[var(--color-surface)] pr-8 pl-3 text-[14px] text-[var(--color-ink-900)] transition-colors',
            'disabled:cursor-not-allowed disabled:bg-[var(--color-surface-sunken)] disabled:text-[var(--color-ink-400)]',
            error ? 'border-[var(--color-conflict)]' : 'border-[var(--color-hairline)]',
          )}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <svg
          className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-[var(--color-ink-400)]"
          viewBox="0 0 14 14"
          fill="none"
          aria-hidden="true"
          focusable="false"
        >
          <path d="m3.5 5.5 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {error && (
        <p id={messageId} className="text-[13px] text-[var(--color-conflict)]">
          {error}
        </p>
      )}
    </div>
  )
})
