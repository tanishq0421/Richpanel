import { useId } from 'react'
import { cn } from '@/lib/cn'
import { DatePicker, FIELD_LABEL_CLASS } from './DatePicker'
import { TimePicker } from './TimePicker'

export interface DateTimeFieldProps {
  date: Date | null
  time: string
  onChange: (v: { date: Date | null; time: string }) => void
  label?: string
  error?: string
}

/**
 * A day and a wall-clock time side by side, reported as one value.
 *
 * The two are kept as separate fields rather than a single `Date` on purpose:
 * the backend reads a naive IST datetime (`helpers/time.ts` → `toNaiveIsoDateTime`),
 * so folding the time into a `Date` here would only invite a UTC conversion
 * somewhere downstream and shift every window by 5h30m.
 */
export function DateTimeField({ date, time, onChange, label, error }: DateTimeFieldProps) {
  const generatedId = useId()
  const labelId = `datetime-${generatedId}-label`
  const messageId = `datetime-${generatedId}-message`

  return (
    <div className="flex w-full flex-col gap-1.5">
      {label && (
        <span id={labelId} className={FIELD_LABEL_CLASS}>
          {label}
        </span>
      )}

      <div
        role="group"
        aria-labelledby={label ? labelId : undefined}
        aria-describedby={error ? messageId : undefined}
        /* One message for the pair, but both triggers should still read as
           invalid. The only buttons inside this group are the two triggers —
           the popovers render in a portal, so they are not caught by this. */
        className={cn(
          'flex items-start gap-2',
          error && '[&_button]:border-[var(--color-conflict)]',
        )}
      >
        <div className="min-w-0 flex-1">
          <DatePicker value={date} onChange={(next) => onChange({ date: next, time })} />
        </div>
        <div className="w-[132px] shrink-0">
          <TimePicker
            value={time}
            onChange={(next) => onChange({ date, time: next })}
            aria-label={label ? `${label} time` : 'Time'}
          />
        </div>
      </div>

      {error && (
        <p id={messageId} className="text-[13px] text-[var(--color-conflict)]">
          {error}
        </p>
      )}
    </div>
  )
}
