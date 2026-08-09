import { Link } from 'react-router-dom'

import type { ScheduleDTO } from '@/api/types'
import { EmptyState, ErrorState } from '@/components/feedback'
import { Badge, Button, Skeleton } from '@/components/ui'
import { cn } from '@/lib/cn'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * `start_date` is a calendar day in IST, not an instant. `new Date('2024-03-01')`
 * would parse it as UTC midnight and render the *previous* day for anyone west
 * of Greenwich, so the string is formatted textually and never round-tripped
 * through a Date.
 */
export function formatIsoDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number)
  return `${day} ${MONTHS[month - 1]} ${year}`
}

export function formatEffectiveRange(startDate: string, endDate: string | null): string {
  return endDate ? `${formatIsoDate(startDate)} – ${formatIsoDate(endDate)}` : `${formatIsoDate(startDate)} – ongoing`
}

/** How many distinct weekdays the schedule covers — the one number that tells a
 *  manager at a glance whether a schedule is full-week or weekend-only. */
export function coveredDayCount(schedule: ScheduleDTO): number {
  return new Set(schedule.shifts.map((shift) => shift.weekday)).size
}

interface ScheduleListProps {
  schedules: ScheduleDTO[] | undefined
  isLoading: boolean
  error: unknown
  onRetry: () => void
  selectedId: number | null
  onCreate: () => void
}

export function ScheduleList({ schedules, isLoading, error, onRetry, selectedId, onCreate }: ScheduleListProps) {
  return (
    <section
      aria-label="Schedules"
      className="flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-hairline)] bg-[var(--color-surface)]"
    >
      <header className="flex items-center gap-3 border-b border-[var(--color-hairline)] px-4 py-3">
        <h2 className="font-[family-name:var(--font-display)] text-[14px] font-semibold text-[var(--color-ink-900)]">
          Schedules
        </h2>
        {schedules ? (
          <span className="tabular text-[12px] text-[var(--color-ink-400)]">{schedules.length}</span>
        ) : null}
        <Button size="sm" variant="secondary" className="ml-auto" onClick={onCreate}>
          New schedule
        </Button>
      </header>

      <div className="p-2">
        {isLoading ? (
          <div className="space-y-1 p-1" aria-busy="true" aria-label="Loading schedules">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="space-y-1.5 px-2 py-2.5">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-2">
            <ErrorState error={error} onRetry={onRetry} />
          </div>
        ) : !schedules || schedules.length === 0 ? (
          <EmptyState
            title="No schedules yet"
            description="A schedule defines the weekly hours an agent is considered available. Create one to start reporting on business hours."
            action={
              <Button size="sm" onClick={onCreate}>
                New schedule
              </Button>
            }
          />
        ) : (
          <ul className="space-y-0.5">
            {schedules.map((schedule) => {
              const days = coveredDayCount(schedule)
              const isSelected = schedule.id === selectedId
              return (
                <li key={schedule.id}>
                  <Link
                    to={`/schedules/${schedule.id}`}
                    aria-current={isSelected ? 'true' : undefined}
                    className={cn(
                      'block rounded-[var(--radius-md)] px-3 py-2.5 transition-colors',
                      isSelected
                        ? 'bg-[var(--color-brand-100)]'
                        : 'hover:bg-[var(--color-surface-sunken)] focus-visible:bg-[var(--color-surface-sunken)]',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'truncate text-[13px] font-medium',
                          isSelected ? 'text-[var(--color-brand-700)]' : 'text-[var(--color-ink-900)]',
                        )}
                      >
                        {schedule.name}
                      </span>
                      <span className="ml-auto shrink-0">
                        {days === 0 ? (
                          <Badge tone="zero">No hours</Badge>
                        ) : (
                          <Badge tone="brand">
                            {days === 7 ? 'Every day' : `${days} ${days === 1 ? 'day' : 'days'}`}
                          </Badge>
                        )}
                      </span>
                    </div>
                    <p className="tabular mt-0.5 text-[12px] text-[var(--color-ink-500)]">
                      {formatEffectiveRange(schedule.start_date, schedule.end_date)}
                    </p>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
