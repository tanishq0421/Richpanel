import { useState } from 'react'

import { ErrorState } from '@/components/feedback'
import { Badge, Button, Card, Skeleton } from '@/components/ui'
import { DeletionImpactModal } from '@/components/modals'
import { useSchedule } from '@/hooks/queries'

import { AssigneeList } from './AssigneeList'
import { ScheduleHoursForm } from './ScheduleForm'
import { coveredDayCount, formatEffectiveRange } from './ScheduleList'

export function ScheduleDetail({ scheduleId, onDeleted }: { scheduleId: number; onDeleted: () => void }) {
  const schedule = useSchedule(scheduleId)
  const [deleteOpen, setDeleteOpen] = useState(false)

  if (schedule.isLoading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading schedule">
        <Card>
          <Skeleton className="h-5 w-56" />
          <Skeleton className="mt-2 h-3.5 w-72" />
        </Card>
        <Card>
          <Skeleton className="h-40 w-full" />
        </Card>
      </div>
    )
  }

  // Covers 404 (deleted by someone else), 500, network and timeout alike —
  // `ErrorState` reads the kind off the ApiError and offers retry only where
  // retrying can plausibly help.
  if (schedule.error || !schedule.data) {
    return (
      <Card>
        <ErrorState error={schedule.error} onRetry={() => void schedule.refetch()} />
      </Card>
    )
  }

  const data = schedule.data
  const days = coveredDayCount(data)

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <h1 className="font-[family-name:var(--font-display)] text-[20px] leading-tight font-semibold text-[var(--color-ink-900)]">
              {data.name}
            </h1>
            <p className="tabular mt-1 text-[13px] text-[var(--color-ink-500)]">
              {formatEffectiveRange(data.start_date, data.end_date)}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {days === 0 ? (
              <Badge tone="zero">No hours set</Badge>
            ) : (
              <Badge tone="brand">
                {days} {days === 1 ? 'day' : 'days'} covered
              </Badge>
            )}
            <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
              Delete
            </Button>
          </div>
        </div>
      </Card>

      <ScheduleHoursForm schedule={data} />

      <AssigneeList scheduleId={data.id} />

      <DeletionImpactModal
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        scheduleId={data.id}
        scheduleName={data.name}
        onDeleted={onDeleted}
      />
    </div>
  )
}
