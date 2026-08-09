import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { EmptyState } from '@/components/feedback'
import { Card } from '@/components/ui'
import { useSchedules } from '@/hooks/queries'

import { ScheduleDetail } from './ScheduleDetail'
import { ScheduleCreateForm } from './ScheduleForm'
import { ScheduleList } from './ScheduleList'

/**
 * Master–detail rather than list-then-page: the common task is comparing a few
 * schedules and moving agents between them, which a full page transition per
 * schedule makes needlessly slow.
 */
export function SchedulesPage() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)

  const schedules = useSchedules()

  const parsedId = params.id ? Number(params.id) : NaN
  const selectedId = Number.isFinite(parsedId) ? parsedId : null

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
      <ScheduleList
        schedules={schedules.data}
        isLoading={schedules.isLoading}
        error={schedules.error}
        onRetry={() => void schedules.refetch()}
        selectedId={creating ? null : selectedId}
        onCreate={() => {
          setCreating(true)
          navigate('/schedules')
        }}
      />

      <div className="min-w-0">
        {creating ? (
          <ScheduleCreateForm
            onCancel={() => setCreating(false)}
            onCreated={(schedule) => {
              setCreating(false)
              navigate(`/schedules/${schedule.id}`)
            }}
          />
        ) : selectedId !== null ? (
          <ScheduleDetail
            scheduleId={selectedId}
            onDeleted={() => {
              void schedules.refetch()
              navigate('/schedules')
            }}
          />
        ) : (
          <Card>
            <EmptyState
              title="Select a schedule"
              description="Pick a schedule to review its weekly hours and the agents assigned to it, or create a new one."
            />
          </Card>
        )}
      </div>
    </div>
  )
}

export default SchedulesPage
