import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ShiftDTO, Weekday } from '@/api/types'
import { WEEKDAYS, nextWeekday, weekdayLong, weekdayShort } from '@/helpers/weekday'
import { formatBusinessSeconds, hhmmToHours, hoursToHHMM, isOvernight, shiftDurationHours } from '@/helpers/time'
import { TimePicker } from '@/components/datetime/TimePicker'
import { cn } from '@/lib/cn'

export interface WeeklyHoursEditorProps {
  value: ShiftDTO[]
  onChange: (shifts: ShiftDTO[]) => void
  disabled?: boolean
  error?: string
}

/** What a day gets when it is switched on. 09:00–17:00 is the shape most rows
 *  end up as, so the common case needs no edits at all. */
const DEFAULT_START_HOURS = 9
const DEFAULT_END_HOURS = 17

export const MIDNIGHT_END_MESSAGE =
  'A shift cannot end at 00:00. Use 23:45 to cover the day right up to midnight.'
export const ZERO_LENGTH_MESSAGE =
  'Start and end cannot be the same time — the shift would have no length.'

/**
 * The two shapes the backend rejects with a 422. They are checked here, on the
 * exact keystroke that creates them, because both are indistinguishable to the
 * server from something the user might plausibly have meant: `end 00:00` reads
 * as "midnight" to a human but is a zero-hours day on the wire, and
 * `start === end` reads as "all day" but is stored as an empty window.
 *
 * Exported so a page can reuse the same rule rather than re-deriving it.
 */
export function shiftError(startHHMM: string, endHHMM: string): string | null {
  if (endHHMM === '00:00') return MIDNIGHT_END_MESSAGE
  if (startHHMM === endHHMM) return ZERO_LENGTH_MESSAGE
  return null
}

const percent = (hours: number) => `${(hours / 24) * 100}%`

/** The continuation fill: hatched so it can never be mistaken for a bar the
 *  user can edit, and tinted with the same coverage token so the eye reads the
 *  two halves of an overnight shift as one thing. */
const HATCH_BACKGROUND = [
  'repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-covered) 42%, transparent) 0 3px, transparent 3px 7px)',
  'color-mix(in srgb, var(--color-covered) 9%, transparent)',
].join(', ')

const GRID = 'grid grid-cols-[168px_112px_112px_68px_minmax(200px,1fr)] items-center gap-x-3'

/** "8 hours", "7 hours 30 minutes" — what a screen reader should say. The
 *  visible column uses the compact "8h" form instead. */
function spokenDuration(hours: number): string {
  const totalMinutes = Math.round(hours * 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h} ${h === 1 ? 'hour' : 'hours'}`)
  if (m > 0) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`)
  return parts.length > 0 ? parts.join(' ') : '0 hours'
}

interface DayRowProps {
  weekday: Weekday
  /** null when the day is not worked. Primitives, not the ShiftDTO object —
   *  see the memoisation note on `DayRow`. */
  startHours: number | null
  endHours: number | null
  /** Set when the *previous* weekday's shift runs past midnight into this one. */
  incomingFrom: Weekday | null
  incomingEndHours: number | null
  disabled: boolean
  onChangeDay: (weekday: Weekday, next: ShiftDTO | null) => void
}

/**
 * MEMOISATION — how "changing Monday must not re-render the other six" is met.
 *
 * Two things make the default shallow compare of `memo` sufficient here, and
 * both are deliberate:
 *
 *  1. The row takes **primitives** (`startHours`, `endHours`, `incoming*`), not
 *     the `ShiftDTO` object out of `value`. Object props would defeat the memo
 *     the first time a parent page rebuilt its shift array with fresh literals
 *     — the array is re-created on every edit, so identity there is not
 *     something this component can rely on. Numbers always compare equal.
 *  2. `onChangeDay` is a `useCallback` with an **empty** dependency array. It
 *     reads the current `value`/`onChange` through a ref, so it never has to
 *     depend on them and therefore never changes identity — a handler rebuilt
 *     on every parent render would re-render all seven rows regardless of memo.
 *
 * The in-flight invalid draft is row-local state, so a rejected keystroke on
 * Monday re-renders exactly one row and touches nothing else.
 */
const DayRow = memo(function DayRow({
  weekday,
  startHours,
  endHours,
  incomingFrom,
  incomingEndHours,
  disabled,
  onChangeDay,
}: DayRowProps) {
  /**
   * A value the user picked that the backend would reject. It is held here
   * rather than pushed up through `onChange` so that `value` is *always* a
   * schedule the API would accept — the page's Save button cannot submit a
   * 422 even if it wanted to. The picker still shows what was typed (snapping
   * silently back to the old time reads as a broken control), with the reason
   * spelled out underneath.
   */
  const [draft, setDraft] = useState<{ start: string; end: string } | null>(null)

  // One object rather than two loose numbers, so every downstream use is
  // narrowed by a single truthiness check instead of re-testing both halves.
  const committed = startHours !== null && endHours !== null ? { start: startHours, end: endHours } : null
  const worked = committed !== null

  const startHHMM = draft ? draft.start : committed ? hoursToHHMM(committed.start) : hoursToHHMM(DEFAULT_START_HOURS)
  const endHHMM = draft ? draft.end : committed ? hoursToHHMM(committed.end) : hoursToHHMM(DEFAULT_END_HOURS)
  const rowError = draft ? shiftError(draft.start, draft.end) : null

  const long = weekdayLong(weekday)
  const overnight = committed !== null && !rowError && isOvernight(committed.start, committed.end)
  const durationHours = committed !== null && !rowError ? shiftDurationHours(committed.start, committed.end) : 0

  const commit = useCallback(
    (nextStart: string, nextEnd: string) => {
      const problem = shiftError(nextStart, nextEnd)
      if (problem) {
        setDraft({ start: nextStart, end: nextEnd })
        return
      }
      setDraft(null)
      onChangeDay(weekday, {
        weekday,
        start_hours: hhmmToHours(nextStart),
        end_hours: hhmmToHours(nextEnd),
      })
    },
    [onChangeDay, weekday],
  )

  const toggle = useCallback(() => {
    setDraft(null)
    onChangeDay(
      weekday,
      worked ? null : { weekday, start_hours: DEFAULT_START_HOURS, end_hours: DEFAULT_END_HOURS },
    )
  }, [onChangeDay, weekday, worked])

  // One sentence per row, because that is how it is heard: the label carries
  // the times, the length, the midnight crossing and any continuation, so a
  // screen-reader user never has to reconstruct the week from seven fragments.
  const groupLabel = [
    rowError
      ? `${long}, ${startHHMM} to ${endHHMM}. ${rowError}`
      : worked
        ? `${long}, ${startHHMM} to ${endHHMM}${overnight ? ' the next day' : ''}, ${spokenDuration(durationHours)}`
        : `${long}, not worked`,
    incomingFrom !== null && incomingEndHours !== null
      ? `${weekdayLong(incomingFrom)}'s shift continues until ${hoursToHHMM(incomingEndHours)}.`
      : '',
  ]
    .filter(Boolean)
    .join('. ')

  return (
    <div
      role="group"
      aria-label={groupLabel}
      className={cn(
        'border-b border-[var(--color-hairline)] px-3 py-2 last:border-b-0',
        worked ? 'bg-[var(--color-surface)]' : 'bg-[var(--color-surface-sunken)]',
      )}
    >
      <div className={GRID}>
        {/* ── day + on/off ───────────────────────────────────────────────── */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            role="switch"
            aria-checked={worked}
            aria-label={`Work on ${long}`}
            disabled={disabled}
            onClick={toggle}
            className={cn(
              'relative h-5 w-9 shrink-0 rounded-[var(--radius-pill)] transition-colors',
              worked ? 'bg-[var(--color-covered)]' : 'bg-[var(--color-ink-200)]',
              disabled && 'cursor-not-allowed opacity-45',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-all',
                worked ? 'left-[18px]' : 'left-0.5',
              )}
            />
          </button>
          <span
            className={cn(
              'text-[13px] font-medium',
              worked ? 'text-[var(--color-ink-900)]' : 'text-[var(--color-ink-400)]',
            )}
          >
            {long}
          </span>
        </div>

        {/* ── times ──────────────────────────────────────────────────────── */}
        <div className={cn('min-w-0', !worked && 'pointer-events-none opacity-40')}>
          {/* The rejection message is deliberately NOT passed to either picker:
              the rule is about the pair, not about one field, so it is rendered
              once for the row rather than twice, once under each control. */}
          <TimePicker
            value={startHHMM}
            onChange={(next) => commit(next, endHHMM)}
            aria-label={`${long} start time`}
            disabled={disabled || !worked}
          />
        </div>

        <div className={cn('min-w-0', !worked && 'pointer-events-none opacity-40')}>
          <TimePicker
            value={endHHMM}
            onChange={(next) => commit(startHHMM, next)}
            aria-label={`${long} end time`}
            disabled={disabled || !worked}
          />
        </div>

        {/* ── duration ───────────────────────────────────────────────────── */}
        <div
          className={cn(
            'tabular text-right text-[13px]',
            worked && !rowError ? 'text-[var(--color-ink-700)]' : 'text-[var(--color-zero)]',
          )}
        >
          {worked && !rowError ? formatBusinessSeconds(durationHours * 3600) : '—'}
        </div>

        {/* ── 24-hour track ──────────────────────────────────────────────── */}
        <div
          aria-hidden="true"
          className="relative h-7 w-full overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-hairline)] bg-[var(--color-surface-sunken)]"
        >
          {[6, 12, 18].map((hour) => (
            <div
              key={hour}
              className="absolute inset-y-0 w-px bg-[var(--color-hairline)]"
              style={{ left: percent(hour) }}
            />
          ))}

          {/* The tail of the PREVIOUS day's overnight shift. Read-only: it is
              edited on the row that owns it, one above (or on Sunday's row, for
              Monday). Squared off on the left because it arrives from off-track. */}
          {incomingFrom !== null && incomingEndHours !== null && (
            <div
              className="absolute inset-y-[3px] left-0 flex items-center justify-end overflow-hidden rounded-r-[3px] pr-1"
              style={{ width: percent(incomingEndHours), background: HATCH_BACKGROUND }}
              title={`Continuation of ${weekdayLong(incomingFrom)}'s shift, until ${hoursToHHMM(incomingEndHours)}`}
            >
              <span className="text-[9px] font-semibold tracking-wide whitespace-nowrap text-[var(--color-brand-700)]">
                ↳ {weekdayShort(incomingFrom)}
              </span>
            </div>
          )}

          {/* This day's own shift. When it is overnight the bar runs to the
              right edge with no rounding and an arrow — it does not stop at
              23:59, it leaves the track, and the hatched tail on the next row
              is where it lands. */}
          {committed !== null && !rowError && (
            <div
              className="absolute inset-y-[3px] flex items-center justify-end bg-[var(--color-covered)] pr-1"
              style={{
                left: percent(committed.start),
                width: percent(overnight ? 24 - committed.start : committed.end - committed.start),
                borderRadius: overnight ? '3px 0 0 3px' : '3px',
              }}
            >
              {overnight && <span className="text-[10px] leading-none font-bold text-white">→</span>}
            </div>
          )}
        </div>
      </div>

      {rowError && (
        <p className="mt-1.5 pl-[180px] text-[12px] text-[var(--color-conflict)]" role="alert">
          {rowError}
        </p>
      )}
    </div>
  )
})

/**
 * THE WEEK RIBBON — editor and visualisation in one control.
 *
 * The seven-row shape is not decoration: it is how "exactly one time window per
 * weekday" is enforced. There is no "add another window" affordance because the
 * backend has no such concept (it answers 422), so a user physically cannot
 * build a split shift and then be told no. A lunch break is expressed by not
 * having one — which is honest about what this product models.
 *
 * An overnight shift is entered as one thing (`end` earlier than `start`) and
 * drawn as one thing: a solid bar leaving the right edge of its own day and a
 * hatched, non-interactive tail arriving on the next day's track. Sunday's tail
 * lands on Monday, via `nextWeekday`.
 */
export function WeeklyHoursEditor({ value, onChange, disabled = false, error }: WeeklyHoursEditorProps) {
  const byWeekday = useMemo(() => {
    const map = new Map<Weekday, ShiftDTO>()
    // Last one wins. The invariant is one window per weekday; if a caller ever
    // hands us two, rendering both would imply the editor supports something it
    // does not, so it collapses instead.
    for (const shift of value) map.set(shift.weekday, shift)
    return map
  }, [value])

  /** weekday -> the shift spilling into it from the day before. */
  const continuations = useMemo(() => {
    const map = new Map<Weekday, { from: Weekday; endHours: number }>()
    for (const shift of value) {
      if (isOvernight(shift.start_hours, shift.end_hours)) {
        map.set(nextWeekday(shift.weekday), { from: shift.weekday, endHours: shift.end_hours })
      }
    }
    return map
  }, [value])

  // The "latest" ref is what lets `onChangeDay` keep an empty dependency array
  // and so a stable identity across renders — see the memo note on DayRow.
  const latest = useRef({ value, onChange })
  useEffect(() => {
    latest.current = { value, onChange }
  })

  const onChangeDay = useCallback((weekday: Weekday, next: ShiftDTO | null) => {
    const { value: current, onChange: emit } = latest.current
    const rest = current.filter((shift) => shift.weekday !== weekday)
    const out = next ? [...rest, next] : rest
    out.sort((a, b) => a.weekday - b.weekday)
    emit(out)
  }, [])

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <div className="min-w-[760px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-hairline)]">
          {/* Column headings, and the hour axis the tracks are read against. */}
          <div
            className={cn(
              GRID,
              'border-b border-[var(--color-hairline)] bg-[var(--color-surface-sunken)] px-3 py-2',
            )}
          >
            <span className="text-[11px] font-medium tracking-wide text-[var(--color-ink-500)] uppercase">Day</span>
            <span className="text-[11px] font-medium tracking-wide text-[var(--color-ink-500)] uppercase">Start</span>
            <span className="text-[11px] font-medium tracking-wide text-[var(--color-ink-500)] uppercase">End</span>
            <span className="text-right text-[11px] font-medium tracking-wide text-[var(--color-ink-500)] uppercase">
              Hours
            </span>
            <div className="relative h-4" aria-hidden="true">
              {[0, 6, 12, 18, 24].map((hour) => (
                <span
                  key={hour}
                  className={cn(
                    'tabular absolute top-0 text-[10px] text-[var(--color-ink-400)]',
                    hour === 0 && 'left-0',
                    hour === 24 && 'right-0',
                  )}
                  style={hour === 0 || hour === 24 ? undefined : { left: percent(hour), transform: 'translateX(-50%)' }}
                >
                  {String(hour).padStart(2, '0')}
                </span>
              ))}
            </div>
          </div>

          {WEEKDAYS.map((day) => {
            const shift = byWeekday.get(day.value)
            const incoming = continuations.get(day.value)
            return (
              <DayRow
                key={day.value}
                weekday={day.value}
                startHours={shift ? shift.start_hours : null}
                endHours={shift ? shift.end_hours : null}
                incomingFrom={incoming ? incoming.from : null}
                incomingEndHours={incoming ? incoming.endHours : null}
                disabled={disabled}
                onChangeDay={onChangeDay}
              />
            )
          })}
        </div>
      </div>

      {/* Said once, here, so no row has to explain itself: the rule and the
          legend for the hatch. */}
      <p className="text-[12px] text-[var(--color-ink-500)]">
        One window per day. For a shift that runs past midnight, set the end earlier than the start — it is drawn as a
        hatched continuation on the next day and stays one shift.
      </p>

      {error && (
        <p role="alert" className="text-[13px] text-[var(--color-conflict)]">
          {error}
        </p>
      )}
    </div>
  )
}
