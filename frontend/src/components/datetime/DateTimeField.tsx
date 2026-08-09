import { useId, useState } from 'react'
import { isSameDay } from 'date-fns'
import { cn } from '@/lib/cn'
import { MINUTE_STEP, hhmmToHours, hoursToHHMM } from '@/helpers/time'
import { DatePicker, FIELD_LABEL_CLASS } from './DatePicker'
import { TimePicker } from './TimePicker'

export interface DateTimeFieldProps {
  date: Date | null
  time: string
  onChange: (v: { date: Date | null; time: string }) => void
  label?: string
  error?: string
  /**
   * The latest moment this field may hold — a full wall-clock instant, not a
   * day. Days after it are unselectable, and on the boundary day itself the
   * time picker stops at `max`'s own time: bounding the date alone would still
   * leave every hour of today after now on offer.
   */
  max?: Date
}

/**
 * `max` floored onto the picker's step, or `undefined` when `day` is not the
 * boundary day (an earlier day is unbounded — all 24 hours of it are past).
 *
 * Read off local `getHours`/`getMinutes`, never `toISOString()`: every value
 * here is IST wall-clock, and a UTC round trip would move the ceiling back
 * 5h30m and bound the wrong day entirely.
 */
function ceilingFor(day: Date | null, max: Date | undefined): string | undefined {
  if (!day || !max || !isSameDay(day, max)) return undefined
  const minutes = max.getHours() * 60 + max.getMinutes()
  return hoursToHHMM((minutes - (minutes % MINUTE_STEP)) / 60)
}

/**
 * A day and a wall-clock time side by side, reported as one value.
 *
 * The two are kept as separate fields rather than a single `Date` on purpose:
 * the backend reads a naive IST datetime (`helpers/time.ts` → `toNaiveIsoDateTime`),
 * so folding the time into a `Date` here would only invite a UTC conversion
 * somewhere downstream and shift every window by 5h30m.
 */
export function DateTimeField({ date, time, onChange, label, error, max }: DateTimeFieldProps) {
  const generatedId = useId()
  const labelId = `datetime-${generatedId}-label`
  const messageId = `datetime-${generatedId}-message`

  // Set only when a date change dragged the held time out of range, and cleared
  // by the next edit. See `handleDateChange`.
  const [notice, setNotice] = useState<string | null>(null)

  const maxTime = ceilingFor(date, max)

  /**
   * Moving the date onto the boundary day can strand a time that was perfectly
   * legal on the old day — 18:00 chosen yesterday is in the future once the day
   * becomes today. The value is pulled back to the last legal step and the move
   * is stated out loud rather than left to be discovered at submit: the one
   * outcome ruled out is a window that quietly still says 18:00.
   */
  function handleDateChange(next: Date | null) {
    const ceiling = ceilingFor(next, max)
    if (ceiling && hhmmToHours(time) > hhmmToHours(ceiling)) {
      setNotice(`Time moved back to ${ceiling} — later times on this date haven’t happened yet.`)
      onChange({ date: next, time: ceiling })
      return
    }
    setNotice(null)
    onChange({ date: next, time })
  }

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
          <DatePicker value={date} onChange={handleDateChange} maxDate={max} />
        </div>
        <div className="w-[132px] shrink-0">
          <TimePicker
            value={time}
            onChange={(next) => {
              setNotice(null)
              onChange({ date, time: next })
            }}
            maxTime={maxTime}
            aria-label={label ? `${label} time` : 'Time'}
          />
        </div>
      </div>

      {error && (
        <p id={messageId} className="text-[13px] text-[var(--color-conflict)]">
          {error}
        </p>
      )}

      {/* Polite, not an alert: the field is now valid again — this only says
          what was changed on the user's behalf. */}
      {notice && !error && (
        <p role="status" className="text-[13px] text-[var(--color-ink-500)]">
          {notice}
        </p>
      )}
    </div>
  )
}
