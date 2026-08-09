import { useNavigate, useParams } from 'react-router-dom'

import { EmptyState } from '@/components/feedback'
import { Card } from '@/components/ui'
import { useReport, useReports } from '@/hooks/queries'

import { AgentHoursTable } from './AgentHoursTable'
import { ReportForm } from './ReportForm'
import { ReportHistory, formatIstWindow } from './ReportHistory'

export function ReportsPage() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()

  const parsedId = params.id ? Number(params.id) : NaN
  const selectedId = Number.isFinite(parsedId) ? parsedId : null

  const reports = useReports()
  const report = useReport(selectedId)

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
      <div className="space-y-4">
        <ReportForm onGenerated={(generated) => navigate(`/reports/${generated.id}`)} />
        <ReportHistory
          reports={reports.data}
          isLoading={reports.isLoading}
          error={reports.error}
          onRetry={() => void reports.refetch()}
          selectedId={selectedId}
        />
      </div>

      <div className="min-w-0">
        {selectedId === null ? (
          <Card>
            <EmptyState
              title="No report selected"
              description="Pick the window a ticket was open for and generate a report to see how many business hours each agent had available."
            />
          </Card>
        ) : (
          <Card
            title="Resolution time report"
            actions={
              report.data ? (
                <span className="tabular text-[12px] text-[var(--color-ink-500)]">{formatIstWindow(report.data)}</span>
              ) : null
            }
          >
            <AgentHoursTable
              report={report.data}
              isLoading={report.isLoading}
              error={report.error}
              onRetry={() => void report.refetch()}
            />
          </Card>
        )}
      </div>
    </div>
  )
}

export default ReportsPage
