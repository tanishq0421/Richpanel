import { useState } from 'react'

import { ApiError } from '@/api/http'
import type { ReportDTO } from '@/api/types'
import { ConflictBanner } from '@/components/feedback'
import { Button, Card } from '@/components/ui'
import { DateTimeField } from '@/components/datetime'
import { userMessage } from '@/helpers/errors'
import { toNaiveIsoDateTime } from '@/helpers/time'
import { useGenerateReport } from '@/hooks/mutations'

interface Moment {
  date: Date | null
  time: string
}

function fieldError(error: unknown, field: string): string | undefined {
  return error instanceof ApiError ? error.fieldError(field) : undefined
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

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    const next: { start?: string; end?: string } = {}
    if (!start.date) next.start = 'Pick the date the ticket was raised.'
    if (!end.date) next.end = 'Pick the date the ticket was resolved.'
    if (start.date && end.date && !isBefore(start, end)) next.end = 'Resolution must come after the ticket start.'
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
  const showBanner =
    failure && !(failure instanceof ApiError && failure.kind === 'validation' && failure.details.length > 0)

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
          error={localErrors.start ?? fieldError(generate.error, 'ticket_start_at')}
        />

        <DateTimeField
          label="Ticket resolved"
          date={end.date}
          time={end.time}
          onChange={setEnd}
          error={localErrors.end ?? fieldError(generate.error, 'ticket_end_at')}
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
