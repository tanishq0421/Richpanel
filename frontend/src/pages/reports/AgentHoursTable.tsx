import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import type { ReportDTO } from '@/api/types'
import { EmptyState, ErrorState } from '@/components/feedback'
import { Badge, Skeleton } from '@/components/ui'
import { formatBusinessSeconds } from '@/helpers/time'
import { useAgents } from '@/hooks/queries'
import { useReportRows } from '@/hooks/useReportRows'
import { cn } from '@/lib/cn'

/**
 * Below this many agents the rows are rendered plainly: a windowed list costs a
 * scroll container, absolute positioning and a measurement pass, none of which
 * earns its keep for a team of twelve — and it keeps the DOM honest for tests
 * and for Cmd-F. Above it, a report covering every agent in the org can run to
 * thousands of rows, where rendering them all is what actually janks the page.
 */
const VIRTUALIZE_THRESHOLD = 50
const ROW_HEIGHT = 44

interface AgentHoursTableProps {
  report: ReportDTO | undefined
  isLoading: boolean
  error: unknown
  onRetry: () => void
}

export function AgentHoursTable({ report, isLoading, error, onRetry }: AgentHoursTableProps) {
  // The report carries `agent_id` only; names come from the agents list, so a
  // failure to load agents is a failure of this table and has to be shown.
  const agents = useAgents()
  const rows = useReportRows(report)

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualized = rows.length > VIRTUALIZE_THRESHOLD

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: virtualized ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  if (isLoading || agents.isLoading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading agent hours">
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <Skeleton key={row} className="h-11 w-full" />
        ))}
      </div>
    )
  }

  if (error) return <ErrorState error={error} onRetry={onRetry} />
  if (agents.error) return <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />

  if (!report) {
    return <EmptyState title="No report open" description="Generate a report or pick one from the history." />
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No agents to report on"
        description="Agents are seeded by the platform. Once they exist, every agent appears here with their business hours for this window."
      />
    )
  }

  const withHours = rows.filter((row) => row.businessSeconds > 0).length

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{rows.length} agents</Badge>
        <Badge tone="brand">{withHours} with hours</Badge>
        {/* Zero is a finding, not a fault: these agents had no scheduled
            coverage inside the ticket window. Grey, never red. */}
        <Badge tone="zero">{rows.length - withHours} with none</Badge>
        {virtualized ? (
          <span className="ml-auto text-[12px] text-[var(--color-ink-400)]">Scroll for all {rows.length}</span>
        ) : null}
      </div>

      <div
        role="table"
        aria-label="Business hours by agent"
        aria-rowcount={rows.length + 1}
        className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-hairline)] bg-[var(--color-surface)]"
      >
        <div role="rowgroup" className="border-b border-[var(--color-hairline)] bg-[var(--color-surface-sunken)]">
          <div role="row" className="flex items-center px-4 py-2.5">
            <div
              role="columnheader"
              className="flex-1 text-[11px] font-semibold tracking-wide text-[var(--color-ink-500)] uppercase"
            >
              Agent
            </div>
            <div
              role="columnheader"
              className="w-32 text-right text-[11px] font-semibold tracking-wide text-[var(--color-ink-500)] uppercase"
            >
              Business hours
            </div>
          </div>
        </div>

        <div
          role="rowgroup"
          ref={scrollRef}
          className={cn(virtualized && 'max-h-[560px] overflow-y-auto')}
          data-virtualized={virtualized ? 'true' : 'false'}
        >
          {virtualized ? (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index]
                return (
                  <AgentHoursRow
                    key={row.agentId}
                    agentName={row.agentName}
                    businessSeconds={row.businessSeconds}
                    index={item.index}
                    measureRef={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${item.start}px)`,
                    }}
                  />
                )
              })}
            </div>
          ) : (
            rows.map((row, index) => (
              <AgentHoursRow
                key={row.agentId}
                agentName={row.agentName}
                businessSeconds={row.businessSeconds}
                index={index}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function AgentHoursRow({
  agentName,
  businessSeconds,
  index,
  measureRef,
  style,
}: {
  agentName: string
  businessSeconds: number
  index: number
  measureRef?: (node: HTMLDivElement | null) => void
  style?: React.CSSProperties
}) {
  const isZero = businessSeconds === 0

  return (
    <div
      role="row"
      ref={measureRef}
      data-index={index}
      style={style}
      className="flex items-center border-b border-[var(--color-hairline)] px-4 py-3 last:border-b-0"
    >
      <div role="cell" className="flex-1 truncate text-[13px] text-[var(--color-ink-900)]">
        {agentName}
      </div>
      <div
        role="cell"
        data-zero={isZero ? 'true' : 'false'}
        className={cn(
          'tabular w-32 text-right text-[13px]',
          isZero ? 'text-[var(--color-zero)]' : 'font-medium text-[var(--color-covered)]',
        )}
      >
        {formatBusinessSeconds(businessSeconds)}
      </div>
    </div>
  )
}
