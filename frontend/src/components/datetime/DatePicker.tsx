import { useId, useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { DayPicker, type ClassNames, type Matcher } from 'react-day-picker'
import { format, startOfDay } from 'date-fns'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui'

/* ════════════════════════════════════════════════════════════════════════════
   Shared chrome for every control in this folder.

   `react-day-picker` v9 gives the calendar (grid semantics, roving tabindex,
   arrow/Home/End/PageUp/PageDown, per-day aria-labels) and Radix Popover gives
   the overlay (focus trap, Escape-to-close, focus returned to the trigger,
   outside-click dismissal). Neither is re-implemented here — this file only
   supplies the Richpanel skin and wires the two together.

   Every time in this product is IST. There is deliberately no timezone
   conversion and no `Date.UTC` anywhere in this folder: a day the user clicks
   is read back with the local `getFullYear/getMonth/getDate` fields, which is
   exactly what `helpers/time.ts` sends to the backend as a naive datetime.
   ════════════════════════════════════════════════════════════════════════════ */

/** "15 Mar 2025" — short enough to sit inside a 9-unit-tall trigger. */
export const DATE_FORMAT = 'd MMM yyyy'

/** Matches `ui/Input`'s label so a picker sits flush beside a text field. */
export const FIELD_LABEL_CLASS =
  'text-[11px] font-medium tracking-wide text-[var(--color-ink-500)] uppercase'

/** Matches `ui/Input`'s box, minus the border colour (error state decides it). */
export const TRIGGER_CLASS =
  'flex h-9 w-full items-center gap-2 rounded-[var(--radius-md)] border bg-[var(--color-surface)] px-3 text-left text-[14px] text-[var(--color-ink-900)] transition-colors disabled:cursor-not-allowed disabled:bg-[var(--color-surface-sunken)] disabled:text-[var(--color-ink-400)]'

export function triggerBorder(error?: string): string {
  return error
    ? 'border-[var(--color-conflict)]'
    : 'border-[var(--color-hairline)] hover:border-[var(--color-ink-200)]'
}

export const POPOVER_CLASS =
  'z-50 rounded-[var(--radius-lg)] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3 shadow-[0_16px_40px_-12px_rgb(16_24_40_/_0.24)] outline-none'

export const POPOVER_FOOTER_CLASS =
  'mt-2 flex items-center justify-between gap-2 border-t border-[var(--color-hairline)] pt-2'

const NAV_BUTTON_CLASS =
  'inline-flex size-7 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-ink-500)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink-900)] aria-disabled:pointer-events-none aria-disabled:opacity-30'

/**
 * Selection state lands on the `<td>`, not on the day `<button>`, so the fill
 * is applied through `[&>button]`. Today is a ring rather than a colour: a day
 * that is both today and selected must not end up brand-blue-on-brand-blue.
 */
export const CALENDAR_CLASS_NAMES: Partial<ClassNames> = {
  root: 'text-[13px] text-[var(--color-ink-900)]',
  months: 'relative flex flex-col',
  month: 'flex flex-col gap-1',
  nav: 'absolute top-0 right-0 flex items-center gap-0.5',
  button_previous: NAV_BUTTON_CLASS,
  button_next: NAV_BUTTON_CLASS,
  chevron: 'size-3.5 fill-current',
  month_caption:
    'flex h-7 items-center px-1 text-[13px] font-semibold text-[var(--color-ink-900)]',
  month_grid: 'border-collapse',
  weekday:
    'size-9 pb-1 text-[10px] font-medium tracking-wide text-[var(--color-ink-400)] uppercase',
  day: 'p-0 text-center align-middle',
  day_button:
    'tabular flex size-9 items-center justify-center rounded-[var(--radius-md)] text-[13px] font-medium transition-colors hover:bg-[var(--color-brand-100)] disabled:pointer-events-none',
  today: '[&>button]:font-semibold [&>button]:ring-1 [&>button]:ring-[var(--color-brand)]/40 [&>button]:ring-inset',
  selected:
    '[&>button]:bg-[var(--color-brand)] [&>button]:text-white [&>button]:hover:bg-[var(--color-brand-700)]',
  outside: '[&>button]:text-[var(--color-ink-400)]',
  /**
   * Once a whole leading stretch of the month can be out of range (a schedule
   * cannot start in the past), disabled days stop being a rare edge and become
   * most of the grid — they still have to be *readable* while browsing.
   * `ink-400` at 45% opacity landed near 1.6:1 on `--color-surface`, so the
   * colour is `ink-500` at full strength (~4.9:1, AA for body text) and the
   * unavailability is carried by the strike-through rather than by colour
   * alone, which is also what keeps it off WCAG 1.4.1.
   */
  disabled: '[&>button]:text-[var(--color-ink-500)] [&>button]:line-through',
  hidden: 'invisible',
}

export function CalendarIcon() {
  return (
    <svg
      className="size-4 shrink-0 text-[var(--color-ink-400)]"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="3.25" width="12" height="10.75" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2 6.5h12M5.5 2v2.5M10.5 2v2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Label + trigger + message, laid out exactly like `ui/Input`. */
export function PickerField({
  labelId,
  triggerId,
  label,
  error,
  messageId,
  className,
  children,
}: {
  labelId: string
  triggerId: string
  label?: string
  error?: string
  messageId: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('flex w-full flex-col gap-1.5', className)}>
      {label && (
        <label id={labelId} htmlFor={triggerId} className={FIELD_LABEL_CLASS}>
          {label}
        </label>
      )}

      {children}

      {error && (
        <p id={messageId} className="text-[13px] text-[var(--color-conflict)]">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * The accessible name of a picker trigger has to carry the value as well as the
 * label — a screen reader user hearing only "Start date, button" has no idea
 * what is currently selected. So the name is built from the label *and* the
 * span holding the formatted value: "Start date 15 Mar 2025".
 *
 * Deliberately not the trigger's own id. The name algorithm skips nodes it has
 * already visited, so a self-reference silently collapses back to just the
 * label — which is exactly the announcement this is trying to avoid.
 *
 * With no label there is nothing to prepend: the button's own text content is
 * already the value, so the default name is correct.
 */
export function nameOfTrigger(labelId: string | undefined, valueId: string): string | undefined {
  return labelId ? `${labelId} ${valueId}` : undefined
}

/* ════════════════════════════════════════════════════════════════════════════
   DatePicker
   ════════════════════════════════════════════════════════════════════════════ */

export interface DatePickerProps {
  value: Date | null
  onChange: (d: Date | null) => void
  label?: string
  error?: string
  minDate?: Date
  maxDate?: Date
  placeholder?: string
  id?: string
}

export function DatePicker({
  value,
  onChange,
  label,
  error,
  minDate,
  maxDate,
  placeholder = 'Select a date',
  id,
}: DatePickerProps) {
  const generatedId = useId()
  const triggerId = id ?? `date-${generatedId}`
  const labelId = `${triggerId}-label`
  const messageId = `${triggerId}-message`
  const valueId = `${triggerId}-value`

  const [open, setOpen] = useState(false)
  // The calendar opens on the month of the current value, not on wherever the
  // user last browsed to — reopening a field should always show its own value.
  const [month, setMonth] = useState<Date>(value ?? new Date())

  const disabled: Matcher[] = []
  if (minDate) disabled.push({ before: startOfDay(minDate) })
  if (maxDate) disabled.push({ after: startOfDay(maxDate) })

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) setMonth(value ?? new Date())
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
            <span
              id={valueId}
              className={cn('tabular truncate', !value && 'text-[var(--color-ink-400)]')}
            >
              {value ? format(value, DATE_FORMAT) : placeholder}
            </span>
          </button>
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            className={POPOVER_CLASS}
            aria-label={label ? `${label} calendar` : 'Calendar'}
            /* react-day-picker's own `autoFocus` lands focus on the selected
               day (or today). Radix would otherwise steal it for the first
               tabbable node, which is the "previous month" arrow. */
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <DayPicker
              mode="single"
              autoFocus
              selected={value ?? undefined}
              month={month}
              onMonthChange={setMonth}
              onSelect={(next) => {
                onChange(next ? startOfDay(next) : null)
                setOpen(false)
              }}
              disabled={disabled}
              startMonth={minDate}
              endMonth={maxDate}
              weekStartsOn={1}
              classNames={CALENDAR_CLASS_NAMES}
            />

            <div className={POPOVER_FOOTER_CLASS}>
              <Button type="button" variant="ghost" size="sm" onClick={() => setMonth(new Date())}>
                Today
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!value}
                onClick={() => {
                  onChange(null)
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
