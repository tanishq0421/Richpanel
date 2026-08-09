import { Link } from 'react-router-dom'

import type { ReportDTO } from '@/api/types'
import { EmptyState, ErrorState } from '@/components/feedback'
import { Skeleton } from '@/components/ui'
import { cn } from '@/lib/cn'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * `2024-03-01T09:00:00+05:30` → `1 Mar 2024, 09:00`.
 *
 * Formatted straight off the string. The offset is always +05:30 and the whole
 * product is IST; pushing it through `Date` + `toLocaleString` would re-render
 * the same instant in whatever zone the browser happens to be in, so a report
 * generated for 09:00 would read 03:30 to a colleague in London.
 */
export function formatIstDateTime(iso: string): string {
  const [datePart, timePart = ''] = iso.split('T')
  const [year, month, day] = datePart.split('-').map(Number)
  return `${day} ${MONTHS[month - 1]} ${year}, ${timePart.slice(0, 5)}`
}

export function formatIstWindow(report: ReportDTO): string {
  return `${formatIstDateTime(report.ticket_start_at)} → ${formatIstDateTime(report.ticket_end_at)}`
}

interface ReportHistoryProps {
  reports: ReportDTO[] | undefined
  isLoading: boolean
  error: unknown
  onRetry: () => void
  selectedId: number | null
}

export function ReportHistory({ reports, isLoading, error, onRetry, selectedId }: ReportHistoryProps) {
  return (
    <section
      aria-label="Past reports"
      className="flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-hairline)] bg-[var(--color-surface)]"
    >
      <header className="flex items-center gap-3 border-b border-[var(--color-hairline)] px-4 py-3">
        <h2 className="font-[family-name:var(--font-display)] text-[14px] font-semibold text-[var(--color-ink-900)]">
          Past reports
        </h2>
        {reports ? <span className="tabular text-[12px] text-[var(--color-ink-400)]">{reports.length}</span> : null}
      </header>

      <div className="p-2">
        {isLoading ? (
          <div className="space-y-1 p-1" aria-busy="true" aria-label="Loading past reports">
            {[0, 1, 2].map((row) => (
              <div key={row} className="space-y-1.5 px-2 py-2.5">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-2">
            <ErrorState error={error} onRetry={onRetry} />
          </div>
        ) : !reports || reports.length === 0 ? (
          <EmptyState
            title="No reports yet"
            description="Generate one above and it will be kept here so you can reopen it later."
          />
        ) : (
          /* Deliberately no hours in this list. `GET /reports` returns
             `agent_hours: []` for every row — that is the detail being omitted,
             not a team that logged zero hours, and rendering "0h" here would be
             a lie the reader has no way to detect. */
          <ul className="space-y-0.5">
            {reports.map((report) => {
              const isSelected = report.id === selectedId
              return (
                <li key={report.id}>
                  <Link
                    to={`/reports/${report.id}`}
                    aria-current={isSelected ? 'true' : undefined}
                    className={cn(
                      'block rounded-[var(--radius-md)] px-3 py-2.5 transition-colors',
                      isSelected ? 'bg-[var(--color-brand-100)]' : 'hover:bg-[var(--color-surface-sunken)]',
                    )}
                  >
                    <p
                      className={cn(
                        'tabular text-[12.5px] font-medium',
                        isSelected ? 'text-[var(--color-brand-700)]' : 'text-[var(--color-ink-900)]',
                      )}
                    >
                      {formatIstDateTime(report.ticket_start_at)}
                    </p>
                    <p className="tabular mt-0.5 text-[12px] text-[var(--color-ink-500)]">
                      to {formatIstDateTime(report.ticket_end_at)}
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
