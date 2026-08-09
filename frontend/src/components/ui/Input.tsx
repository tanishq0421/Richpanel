import { forwardRef, useId, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, id, className, 'aria-describedby': describedBy, ...props },
  ref,
) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const messageId = `${inputId}-message`

  // The error replaces the hint rather than stacking below it: two lines of
  // guidance under one field is noise, and the error is the actionable one.
  const message = error ?? hint
  const description = [message ? messageId : null, describedBy].filter(Boolean).join(' ') || undefined

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label
          htmlFor={inputId}
          className="text-[11px] font-medium tracking-wide text-[var(--color-ink-500)] uppercase"
        >
          {label}
        </label>
      )}

      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={description}
        className={cn(
          'h-9 rounded-[var(--radius-md)] border bg-[var(--color-surface)] px-3 text-[14px] text-[var(--color-ink-900)] transition-colors',
          'placeholder:text-[var(--color-ink-400)]',
          'disabled:cursor-not-allowed disabled:bg-[var(--color-surface-sunken)] disabled:text-[var(--color-ink-400)]',
          error ? 'border-[var(--color-conflict)]' : 'border-[var(--color-hairline)]',
        )}
        {...props}
      />

      {message && (
        <p
          id={messageId}
          className={cn(
            'text-[13px]',
            error ? 'text-[var(--color-conflict)]' : 'text-[var(--color-ink-500)]',
          )}
        >
          {message}
        </p>
      )}
    </div>
  )
})
