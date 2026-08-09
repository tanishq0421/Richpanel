import { useId, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { DayPicker, type ClassNames, type Matcher } from 'react-day-picker'
import { format, startOfDay } from 'date-fns'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui'
import {
  CALENDAR_CLASS_NAMES,
  CalendarIcon,
  DATE_FORMAT,
  PickerField,
  POPOVER_CLASS,
  POPOVER_FOOTER_CLASS,
  TRIGGER_CLASS,
  nameOfTrigger,
  triggerBorder,
} from './DatePicker'

/**
 * In range mode react-day-picker marks *every* day of the range as `selected`,
 * so the plain `selected` fill has to be beaten back for the middle days. Class
 * order in the attribute does not decide that fight — Tailwind's output order
 * does — so the middle overrides are marked important on purpose.
 */
const RANGE_CLASS_NAMES: Partial<ClassNames> = {
  ...CALENDAR_CLASS_NAMES,
  range_start: 'rounded-l-[var(--radius-md)] bg-[var(--color-brand-100)]',
  range_end: 'rounded-r-[var(--radius-md)] bg-[var(--color-brand-100)]',
  range_middle:
    'bg-[var(--color-brand-100)] [&>button]:rounded-none! [&>button]:bg-transparent! [&>button]:font-normal! [&>button]:text-[var(--color-brand-700)]!',
}

/**
 * Note before reaching for this: react-day-picker's range mode restarts the
 * selection once a range is complete — the next click sets `from` to the day
 * clicked and drops `to`. That is right for "pick a window" gestures and wrong
 * wherever the two ends are separate, individually-editable fields, because a
 * stray click silently discards `to`. `ScheduleForm` hit exactly that (a null
 * `end_date` there means "ongoing", so the click changed the schedule's
 * meaning) and now composes two `DatePicker`s instead. Nothing in the app
 * renders this component today.
 */
export interface DateRangePickerProps {
  from: Date | null
  to: Date | null
  onChange: (r: { from: Date | null; to: Date | null }) => void
  label?: string
  error?: string
  /** Earliest selectable day, inclusive — the bound itself stays pickable. */
  minDate?: Date
  /** Latest selectable day, inclusive. */
  maxDate?: Date
}

export function DateRangePicker({
  from,
  to,
  onChange,
  label,
  error,
  minDate,
  maxDate,
}: DateRangePickerProps) {
  const generatedId = useId()
  const triggerId = `range-${generatedId}`
  const labelId = `${triggerId}-label`
  const messageId = `${triggerId}-message`
  const valueId = `${triggerId}-value`

  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState<Date>(from ?? new Date())

  /**
   * Same shape as `DatePicker`'s. `before`/`after` are exclusive, so passing
   * `startOfDay(minDate)` leaves the bound day itself selectable — a schedule
   * starting *today* is allowed, only yesterday is not.
   *
   * Handed to react-day-picker rather than checked in `onSelect`, so a day out
   * of range is genuinely unreachable: `disabled` sets `disabled` on the day
   * button (no click, no keyboard landing, skipped by the roving tabindex),
   * not merely rejected once pressed.
   */
  const disabled: Matcher[] = []
  if (minDate) disabled.push({ before: startOfDay(minDate) })
  if (maxDate) disabled.push({ after: startOfDay(maxDate) })

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) setMonth(from ?? new Date())
  }

  return (
    <PickerField
      labelId={labelId}
      triggerId={triggerId}
      label={label}
      error={error}
      messageId={messageId}
    >
      <Popover.Root open={open} onOpenChange={handleOpenChange}>
        <Popover.Trigger asChild>
          <button
            type="button"
            id={triggerId}
            aria-labelledby={nameOfTrigger(label ? labelId : undefined, valueId)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? messageId : undefined}
            className={cn(TRIGGER_CLASS, triggerBorder(error))}
          >
            <CalendarIcon />
            {from ? (
              /* A schedule with no end date is the normal case here, not a
                 half-finished input, so the trigger says so in words. An en
                 dash trailing into nothing would read as broken. */
              <span id={valueId} className="tabular truncate">
                {format(from, DATE_FORMAT)}
                {' – '}
                {to ? (
                  format(to, DATE_FORMAT)
                ) : (
                  <span className="text-[var(--color-ink-500)] italic">ongoing</span>
                )}
              </span>
            ) : (
              <span id={valueId} className="text-[var(--color-ink-400)]">
                Select a date range
              </span>
            )}
          </button>
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            className={POPOVER_CLASS}
            aria-label={label ? `${label} calendar` : 'Date range calendar'}
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <DayPicker
              mode="range"
              autoFocus
              selected={from ? { from, to: to ?? undefined } : undefined}
              month={month}
              onMonthChange={setMonth}
              onSelect={(next) => {
                const picked = {
                  from: next?.from ? startOfDay(next.from) : null,
                  to: next?.to ? startOfDay(next.to) : null,
                }
                onChange(picked)
                // Stay open after the first click: the second click is still
                // to come, and an open-ended range is closed deliberately.
                if (picked.from && picked.to) setOpen(false)
              }}
              disabled={disabled}
              startMonth={minDate}
              endMonth={maxDate}
              weekStartsOn={1}
              classNames={RANGE_CLASS_NAMES}
            />

            <p className="mt-1 px-1 text-[12px] text-[var(--color-ink-500)]">
              {from && !to
                ? 'No end date — this range runs indefinitely.'
                : 'Pick a start day, then an end day.'}
            </p>

            <div className={POPOVER_FOOTER_CLASS}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!to}
                onClick={() => onChange({ from, to: null })}
              >
                No end date
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!from && !to}
                onClick={() => {
                  onChange({ from: null, to: null })
                  setOpen(false)
                }}
              >
                Clear
              </Button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </PickerField>
  )
}
