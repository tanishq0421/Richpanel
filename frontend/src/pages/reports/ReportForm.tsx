import { useState } from 'react'

import { ApiError } from '@/api/http'
import type { ReportDTO } from '@/api/types'
import { ConflictBanner } from '@/components/feedback'
import { Button, Card } from '@/components/ui'
import { DateTimeField } from '@/components/datetime'
import { userMessage } from '@/helpers/errors'
import { hoursToHHMM, toNaiveIsoDateTime } from '@/helpers/time'
import { useGenerateReport } from '@/hooks/mutations'

interface Moment {
  date: Date | null
  time: string
}

/**
 * A report answers how many business hours each agent had while a ticket was
 * open. A window reaching past now would take hours nobody has worked yet and
 * present them as history — plausible-looking and wrong. The backend rejects
 * it; this form's job is to keep the user out of that state in the first place.
 */
const FUTURE_WINDOW_MESSAGE = "A report can't cover time that hasn't happened yet."

/**
 * The future-window rule is a pydantic *model* validator, so FastAPI's `loc` is
 * `("body",)` and the detail reaches us as field "body" — verified against the
 * running API, not assumed. `fieldError('ticket_end_at')` misses it entirely,
 * and since the failure is still a 422 carrying details the banner suppressed
 * itself too: the submit was rejected and the form said nothing at all.
 *
 * The detail names the field it concerns inside its own message, and that is
 * what routes it. The wording is replaced rather than passed through: "Value
 * error, ticket_end_at must not be later than the current time" is written for
 * whoever wrote the endpoint, not for the person looking at the screen.
 */
function modelLevelFutureError(error: ApiError, field: string): string | undefined {
  const modelLevel = error.fieldError('body')
  if (!modelLevel || !/future/i.test(modelLevel) || !modelLevel.includes(field)) return undefined
  return FUTURE_WINDOW_MESSAGE
}

/** The message the backend attached to a given form field on a 422, if any. */
function fieldError(error: unknown, field: string): string | undefined {
  if (!(error instanceof ApiError)) return undefined
  return error.fieldError(field) ?? modelLevelFutureError(error, field)
}

/**
 * Now, in the same naive wall-clock shape the window is sent in, so the two
 * compare as plain strings. Built from local `Date` fields and never
 * `toISOString()`: these values are IST, and a UTC round trip would move the
 * ceiling back 5h30m and reject the first hours of every evening.
 *
 * Deliberately the exact current minute rather than the picker's floored step —
 * the picker is then always the stricter of the two, so it can never offer a
 * time this guard would turn around and reject.
 */
function nowAsNaiveIso(): string {
  const now = new Date()
  return toNaiveIsoDateTime(now, hoursToHHMM(now.getHours() + now.getMinutes() / 60))
}

/** Comparable only because both halves are read as IST wall-clock — see the
 *  note on `toNaiveIsoDateTime`. */
function isBefore(a: Moment, b: Moment): boolean {
  if (!a.date || !b.date) return true
  return toNaiveIsoDateTime(a.date, a.time) < toNaiveIsoDateTime(b.date, b.time)
}

export function ReportForm({ onGenerated }: { onGenerated: (report: ReportDTO) => void }) {
  const [start, setStart] = useState<Moment>({ date: null, time: '09:00' })
  const [end, setEnd] = useState<Moment>({ date: null, time: '18:00' })
  const [localErrors, setLocalErrors] = useState<{ start?: string; end?: string }>({})

  const generate = useGenerateReport()
  const pending = generate.isPending

  // Recomputed every render so the ceiling follows the clock rather than the
  // mount time — a tab left open since this morning must not still be offering
  // this morning's hours. The submit guard re-reads it for the same reason.
  const latest = new Date()

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    // The pickers already refuse a future day and, on today, a future time.
    // This is the stale-state case they cannot cover: "now" moves on its own
    // under a tab nobody has touched, so a value that was legal when it was
    // chosen can be in the future by the time Generate is pressed.
    const ceiling = nowAsNaiveIso()

    const next: { start?: string; end?: string } = {}
    if (!start.date) next.start = 'Pick the date the ticket was raised.'
    else if (toNaiveIsoDateTime(start.date, start.time) > ceiling) next.start = FUTURE_WINDOW_MESSAGE

    if (!end.date) next.end = 'Pick the date the ticket was resolved.'
    else if (toNaiveIsoDateTime(end.date, end.time) > ceiling) next.end = FUTURE_WINDOW_MESSAGE
    else if (start.date && !isBefore(start, end)) next.end = 'Resolution must come after the ticket start.'

    setLocalErrors(next)
    if (Object.keys(next).length > 0) return

    generate.mutate(
      {
        // Naive, never a UTC instant: the backend reads these as IST, and
        // converting here would move every window by 5h30m.
        ticketStartAt: toNaiveIsoDateTime(start.date as Date, start.time),
        ticketEndAt: toNaiveIsoDateTime(end.date as Date, end.time),
      },
      { onSuccess: (report: ReportDTO) => onGenerated(report) },
    )
  }

  const failure = generate.error
  const startFromApi = fieldError(failure, 'ticket_start_at')
  const endFromApi = fieldError(failure, 'ticket_end_at')
  // A 422 that landed on a control would only be repeated by the banner.
  // Anything that landed nowhere — a 409, a 500, a dropped connection, a detail
  // this form cannot address — has to be said out loud, or a rejected submit
  // fails in total silence.
  const showBanner = failure && !startFromApi && !endFromApi

  return (
    <Card title="New report">
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        {failure instanceof ApiError && failure.kind === 'conflict' ? (
          <ConflictBanner message={failure.message} onDismiss={() => generate.reset()} />
        ) : showBanner ? (
          <div
            role="alert"
            className="rounded-[var(--radius-md)] border border-[var(--color-conflict)]/25 bg-[var(--color-conflict-bg)] px-3 py-2.5 text-[13px] text-[var(--color-conflict)]"
          >
            {userMessage(failure)}
          </div>
        ) : null}

        <DateTimeField
          label="Ticket started"
          date={start.date}
          time={start.time}
          onChange={setStart}
          max={latest}
          error={localErrors.start ?? startFromApi}
        />

        <DateTimeField
          label="Ticket resolved"
          date={end.date}
          time={end.time}
          onChange={setEnd}
          max={latest}
          error={localErrors.end ?? endFromApi}
        />

        <div className="flex items-center gap-3 border-t border-[var(--color-hairline)] pt-4">
          <Button type="submit" loading={pending} disabled={pending}>
            Generate report
          </Button>
          <span className="text-[12px] text-[var(--color-ink-400)]">IST</span>
        </div>
      </form>
    </Card>
  )
}
