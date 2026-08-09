import { useEffect, useState } from 'react'
import { startOfToday } from 'date-fns'

import { ApiError } from '@/api/http'
import type { ScheduleDTO, ShiftDTO } from '@/api/types'
import { ConflictBanner } from '@/components/feedback'
import { Button, Card, Input } from '@/components/ui'
import { DatePicker } from '@/components/datetime'
// Imported from the module rather than the barrel: `components/datetime/index.ts`
// does not re-export it yet.
import { WeeklyHoursEditor } from '@/components/datetime/WeeklyHoursEditor'
import { userMessage } from '@/helpers/errors'
import { toIsoDate } from '@/helpers/time'
import { useCreateSchedule, useUpdateSchedule } from '@/hooks/mutations'

import { formatIsoDate } from './ScheduleList'

/** The message the backend attached to a specific field on a 422, if any. */
function fieldError(error: unknown, field: string): string | undefined {
  return error instanceof ApiError ? error.fieldError(field) : undefined
}

/**
 * Everything that is *not* already pinned to a control. A 422 whose details are
 * displayed next to the offending inputs would only be repeated here, but a 409,
 * a 500, a timeout or a dropped connection has nowhere else to go — and a form
 * that fails silently is worse than one that fails loudly.
 *
 * The `details.length > 0` suppression below used to hide the banner for EVERY
 * validation error that carried any detail at all — including a body-level one
 * (see `ApiError.bodyError`), which no per-field control ever renders. That
 * combination meant a genuinely rejected submission could show nothing: not a
 * field error (nothing matched), not this banner (suppressed because details
 * existed). `bodyError` is checked explicitly so that specific case still
 * surfaces here.
 */
function SubmitError({ error, onDismiss }: { error: unknown; onDismiss: () => void }) {
  if (!error) return null

  if (error instanceof ApiError) {
    if (error.kind === 'conflict') return <ConflictBanner message={error.message} onDismiss={onDismiss} />
    if (error.kind === 'validation' && error.details.length > 0 && !error.bodyError) return null
  }

  return (
    <div
      role="alert"
      className="rounded-[var(--radius-md)] border border-[var(--color-conflict)]/25 bg-[var(--color-conflict-bg)] px-3 py-2.5 text-[13px] text-[var(--color-conflict)]"
    >
      {userMessage(error)}
    </div>
  )
}

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * A new schedule cannot take effect before today — there is no changing hours
 * that have already been worked. Today itself is fine.
 *
 * Computed from local date fields (`startOfToday`), never `Date.UTC` or
 * `toISOString()`: every time in this product is IST, and a UTC round trip
 * would shift the boundary back a day and reject a schedule starting today for
 * the first 5h30m of every morning.
 */
const PAST_START_MESSAGE = "Schedules can't start in the past."

/**
 * Two fields rather than one range calendar, deliberately.
 *
 * `start_date` and `end_date` are separate fields on the API and mean different
 * things, and a null `end_date` is not a half-finished input — it is the
 * schedule running indefinitely. A range calendar cannot express that: it
 * treats `to` as the second half of a gesture, so clicking once a range is
 * complete restarts it (`from` = the clicked day, `to` = undefined). Here that
 * silently rewrote "1 Jan – 31 Mar" into "ongoing", which is a change to what
 * the schedule *means* and one nobody asked for.
 *
 * Splitting the control removes that failure rather than taming it: each date
 * owns its own state, so changing one cannot clear the other, "ongoing" is
 * reached only through the end field's own Clear, and the two 422 field errors
 * finally land on the control that caused them instead of sharing one slot.
 */
const ONGOING_PLACEHOLDER = 'Ongoing — no end date'

interface ScheduleCreateFormProps {
  onCreated: (schedule: ScheduleDTO) => void
  onCancel: () => void
}

/**
 * Local state is deliberately never cleared on failure: a 422 comes back after
 * the user has filled in a name, a date range and a week of hours, and throwing
 * that away to "reset the form" is the fastest way to make someone give up.
 */
export function ScheduleCreateForm({ onCreated, onCancel }: ScheduleCreateFormProps) {
  const [name, setName] = useState('')
  const [startDate, setStartDate] = useState<Date | null>(null)
  const [endDate, setEndDate] = useState<Date | null>(null)
  const [shifts, setShifts] = useState<ShiftDTO[]>([])
  const [localErrors, setLocalErrors] = useState<{
    name?: string
    startDate?: string
    endDate?: string
  }>({})

  const create = useCreateSchedule()
  const pending = create.isPending

  // Recomputed every render so the calendar's floor follows the clock rather
  // than the mount time — a form left open overnight must not keep offering
  // yesterday. The submit guard below re-reads it for the same reason.
  const earliestStart = startOfToday()

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    const next: { name?: string; startDate?: string; endDate?: string } = {}
    if (!name.trim()) next.name = 'Give the schedule a name.'
    if (!startDate) next.startDate = 'Pick the date this schedule takes effect.'
    // Not only enforced by the picker: state can go stale under a tab that was
    // open when the day rolled over, and the value would then still be sitting
    // in `startDate` after the calendar has already moved its floor forward.
    else if (startDate < startOfToday()) next.startDate = PAST_START_MESSAGE
    // An end before the start is unreachable through the calendar (the end
    // field's floor is the chosen start), but moving the start forward *after*
    // choosing an end can strand one — and the answer is to say so, never to
    // quietly drop the end date the user picked on purpose.
    if (startDate && endDate && endDate < startDate) {
      next.endDate = 'The end date cannot be before the start date.'
    }
    setLocalErrors(next)
    if (Object.keys(next).length > 0) return

    create.mutate(
      {
        name: name.trim(),
        start_date: toIsoDate(startDate as Date),
        end_date: endDate ? toIsoDate(endDate) : null,
        shifts,
      },
      { onSuccess: (schedule: ScheduleDTO) => onCreated(schedule) },
    )
  }

  return (
    <Card title="New schedule">
      <form className="space-y-5" onSubmit={handleSubmit} noValidate>
        <SubmitError error={create.error} onDismiss={() => create.reset()} />

        <Input
          label="Schedule name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="India support — weekdays"
          hint="How this shift pattern will be referred to when assigning agents."
          error={localErrors.name ?? fieldError(create.error, 'name')}
          disabled={pending}
        />

        <div className="space-y-1.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <DatePicker
              label="Starts"
              value={startDate}
              onChange={setStartDate}
              minDate={earliestStart}
              placeholder="Select a start date"
              error={localErrors.startDate ?? fieldError(create.error, 'start_date')}
            />

            <DatePicker
              label="Ends"
              value={endDate}
              onChange={setEndDate}
              /* Floors on the chosen start, so an end before the start is not
                 offered in the first place; today until a start is picked. */
              minDate={startDate ?? earliestStart}
              placeholder={ONGOING_PLACEHOLDER}
              error={localErrors.endDate ?? fieldError(create.error, 'end_date')}
            />
          </div>

          <p className="text-[13px] text-[var(--color-ink-500)]">
            Leave the end date empty and the schedule runs indefinitely — use Clear in its
            calendar to go back to ongoing.
          </p>
        </div>

        <WeeklyHoursEditor
          value={shifts}
          onChange={setShifts}
          disabled={pending}
          error={fieldError(create.error, 'shifts')}
        />

        <div className="flex items-center gap-2 border-t border-[var(--color-hairline)] pt-4">
          <Button type="submit" loading={pending} disabled={pending}>
            Create schedule
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <span className="ml-auto text-[12px] text-[var(--color-ink-400)]">All times IST</span>
        </div>
      </form>
    </Card>
  )
}

// ── Edit ──────────────────────────────────────────────────────────────────────

/**
 * The reverse of `toIsoDate`: builds a *local* midnight `Date` from a
 * `YYYY-MM-DD` string field by field, deliberately never through the `Date`
 * constructor on the raw string — `new Date('2024-03-01')` parses as UTC
 * midnight, which is the previous day for anyone west of Greenwich. Same
 * reasoning as `ScheduleList.tsx`'s `formatIsoDate`, but returning a `Date`
 * rather than text: the pickers below work in `Date`, not strings.
 */
function isoDateToLocalDate(iso: string): Date {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number)
  return new Date(year, month - 1, day)
}

/**
 * Name, dates and hours are all editable here — the API's PUT accepts a
 * partial update of `name`/`start_date`/`end_date` alongside the (always
 * required) `shifts`.
 *
 * Only fields the user actually changed are sent, found by diffing local
 * state against the `schedule` prop at submit time rather than tracking a
 * "touched" flag per field. That choice pulls double duty: a value edited and
 * then edited back to what it already was is correctly treated as
 * unchanged, AND the elapsed-`start_date` lock below falls out of the same
 * mechanism for free — a locked field has no control that can change it, so
 * its local state can never diverge from `schedule.start_date`, so the diff
 * never includes it.
 *
 * Local state is deliberately never cleared on failure — same reasoning as
 * `ScheduleCreateForm`.
 */
export function ScheduleEditForm({ schedule }: { schedule: ScheduleDTO }) {
  const [name, setName] = useState(schedule.name)
  const [startDate, setStartDate] = useState<Date | null>(() => isoDateToLocalDate(schedule.start_date))
  const [endDate, setEndDate] = useState<Date | null>(() =>
    schedule.end_date ? isoDateToLocalDate(schedule.end_date) : null,
  )
  const [shifts, setShifts] = useState<ShiftDTO[]>(schedule.shifts)
  const [dirty, setDirty] = useState(false)
  const [localErrors, setLocalErrors] = useState<{
    name?: string
    startDate?: string
    endDate?: string
  }>({})

  const update = useUpdateSchedule()
  const pending = update.isPending

  // Switching to another schedule must not carry the previous one's unsaved
  // edits across, but a refetch of the same schedule must not stomp on edits
  // in progress either — hence keying on id rather than on the fields below.
  useEffect(() => {
    setName(schedule.name)
    setStartDate(isoDateToLocalDate(schedule.start_date))
    setEndDate(schedule.end_date ? isoDateToLocalDate(schedule.end_date) : null)
    setShifts(schedule.shifts)
    setDirty(false)
    setLocalErrors({})
    update.reset()
  }, [schedule.id]) // deliberately keyed on the id alone — see above

  // Recomputed every render, same reasoning as the create form's
  // `earliestStart`: a form left open across midnight must track the clock,
  // not the mount time — a schedule that starts today must lock the instant
  // today arrives, not whenever this component happened to mount.
  const today = startOfToday()
  const scheduleStartDate = isoDateToLocalDate(schedule.start_date)
  const startDateLocked = scheduleStartDate <= today

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    const next: { name?: string; startDate?: string; endDate?: string } = {}
    if (!name.trim()) next.name = 'Give the schedule a name.'
    // Locked fields have no control to invalidate, so there is nothing to
    // check here beyond what the create form already checks.
    if (!startDateLocked) {
      if (!startDate) next.startDate = 'Pick the date this schedule takes effect.'
      else if (startDate < startOfToday()) next.startDate = PAST_START_MESSAGE
    }
    const effectiveStart = startDate ?? scheduleStartDate
    if (endDate && endDate < effectiveStart) {
      next.endDate = 'The end date cannot be before the start date.'
    }
    setLocalErrors(next)
    if (Object.keys(next).length > 0) return

    const trimmedName = name.trim()
    const startIso = startDate ? toIsoDate(startDate) : null
    const endIso = endDate ? toIsoDate(endDate) : null

    update.mutate(
      {
        id: schedule.id,
        // Each key below is present on the payload only when it actually
        // changed — an absent key leaves the field unchanged server-side,
        // which for `start_date` is what keeps an untouched-but-locked field
        // from ever being sent at all (see `startDateLocked` above).
        ...(trimmedName !== schedule.name ? { name: trimmedName } : {}),
        ...(!startDateLocked && startIso && startIso !== schedule.start_date
          ? { start_date: startIso }
          : {}),
        ...(endIso !== schedule.end_date ? { end_date: endIso } : {}),
        shifts,
      },
      { onSuccess: () => setDirty(false) },
    )
  }

  return (
    <Card title="Edit schedule">
      <form className="space-y-5" onSubmit={handleSubmit} noValidate>
        <SubmitError error={update.error} onDismiss={() => update.reset()} />

        <Input
          label="Schedule name"
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setDirty(true)
          }}
          error={localErrors.name ?? fieldError(update.error, 'name')}
          disabled={pending}
        />

        <div className="space-y-1.5">
          <div className="grid gap-3 sm:grid-cols-2">
            {startDateLocked ? (
              <Input
                label="Starts"
                value={formatIsoDate(schedule.start_date)}
                disabled
                readOnly
                hint="This schedule has already started, so its start date can't be changed."
              />
            ) : (
              <DatePicker
                label="Starts"
                value={startDate}
                onChange={(next) => {
                  setStartDate(next)
                  setDirty(true)
                }}
                minDate={today}
                placeholder="Select a start date"
                error={localErrors.startDate ?? fieldError(update.error, 'start_date')}
              />
            )}

            <DatePicker
              label="Ends"
              value={endDate}
              onChange={(next) => {
                setEndDate(next)
                setDirty(true)
              }}
              /* Floors on the current start (locked or not), so an end before
                 the start is not offered in the first place. */
              minDate={startDate ?? today}
              placeholder={ONGOING_PLACEHOLDER}
              error={localErrors.endDate ?? fieldError(update.error, 'end_date')}
            />
          </div>

          <p className="text-[13px] text-[var(--color-ink-500)]">
            Leave the end date empty and the schedule runs indefinitely — use Clear in its
            calendar to go back to ongoing.
          </p>
        </div>

        <WeeklyHoursEditor
          value={shifts}
          onChange={(next) => {
            setShifts(next)
            setDirty(true)
          }}
          disabled={pending}
          error={fieldError(update.error, 'shifts')}
        />

        <div className="flex items-center gap-3 border-t border-[var(--color-hairline)] pt-4">
          <Button type="submit" loading={pending} disabled={pending || !dirty}>
            Save changes
          </Button>
          <span className="text-[12px] text-[var(--color-ink-400)]">
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
        </div>
      </form>
    </Card>
  )
}
