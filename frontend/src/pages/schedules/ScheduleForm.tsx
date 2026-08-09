import { useEffect, useState } from 'react'

import { ApiError } from '@/api/http'
import type { ScheduleDTO, ShiftDTO } from '@/api/types'
import { ConflictBanner } from '@/components/feedback'
import { Button, Card, Input } from '@/components/ui'
import { DateRangePicker } from '@/components/datetime'
// Imported from the module rather than the barrel: `components/datetime/index.ts`
// does not re-export it yet.
import { WeeklyHoursEditor } from '@/components/datetime/WeeklyHoursEditor'
import { userMessage } from '@/helpers/errors'
import { toIsoDate } from '@/helpers/time'
import { useCreateSchedule, useUpdateScheduleHours } from '@/hooks/mutations'

/** The message the backend attached to a specific field on a 422, if any. */
function fieldError(error: unknown, field: string): string | undefined {
  return error instanceof ApiError ? error.fieldError(field) : undefined
}

/**
 * Everything that is *not* already pinned to a control. A 422 whose details are
 * displayed next to the offending inputs would only be repeated here, but a 409,
 * a 500, a timeout or a dropped connection has nowhere else to go — and a form
 * that fails silently is worse than one that fails loudly.
 */
function SubmitError({ error, onDismiss }: { error: unknown; onDismiss: () => void }) {
  if (!error) return null

  if (error instanceof ApiError) {
    if (error.kind === 'conflict') return <ConflictBanner message={error.message} onDismiss={onDismiss} />
    if (error.kind === 'validation' && error.details.length > 0) return null
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
  const [range, setRange] = useState<{ from: Date | null; to: Date | null }>({ from: null, to: null })
  const [shifts, setShifts] = useState<ShiftDTO[]>([])
  const [localErrors, setLocalErrors] = useState<{ name?: string; range?: string }>({})

  const create = useCreateSchedule()
  const pending = create.isPending

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    const next: { name?: string; range?: string } = {}
    if (!name.trim()) next.name = 'Give the schedule a name.'
    if (!range.from) next.range = 'Pick the date this schedule takes effect.'
    if (range.from && range.to && range.to < range.from) next.range = 'The end date cannot be before the start date.'
    setLocalErrors(next)
    if (Object.keys(next).length > 0) return

    create.mutate(
      {
        name: name.trim(),
        start_date: toIsoDate(range.from as Date),
        end_date: range.to ? toIsoDate(range.to) : null,
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

        <DateRangePicker
          label="Effective dates"
          from={range.from}
          to={range.to}
          onChange={setRange}
          error={
            localErrors.range ??
            fieldError(create.error, 'start_date') ??
            fieldError(create.error, 'end_date')
          }
        />

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
 * Only the hours are editable — the API exposes no way to rename a schedule or
 * move its effective dates, so the form does not pretend otherwise.
 */
export function ScheduleHoursForm({ schedule }: { schedule: ScheduleDTO }) {
  const [shifts, setShifts] = useState<ShiftDTO[]>(schedule.shifts)
  const [dirty, setDirty] = useState(false)

  const update = useUpdateScheduleHours()
  const pending = update.isPending

  // Switching to another schedule must not carry the previous one's unsaved
  // hours across, but a refetch of the same schedule must not stomp on edits
  // in progress either — hence keying on id rather than on the shifts array.
  useEffect(() => {
    setShifts(schedule.shifts)
    setDirty(false)
    update.reset()
  }, [schedule.id]) // deliberately keyed on the id alone — see above

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    update.mutate({ id: schedule.id, shifts }, { onSuccess: () => setDirty(false) })
  }

  return (
    <Card title="Weekly hours">
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        <SubmitError error={update.error} onDismiss={() => update.reset()} />

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
            Save hours
          </Button>
          <span className="text-[12px] text-[var(--color-ink-400)]">
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
        </div>
      </form>
    </Card>
  )
}
