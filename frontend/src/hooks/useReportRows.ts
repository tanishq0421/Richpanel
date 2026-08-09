import { useMemo } from 'react'
import type { ReportDTO } from '@/api/types'
import { useAgents } from '@/hooks/queries/useAgents'

export interface ReportRow {
  agentId: number
  agentName: string
  businessSeconds: number
}

/**
 * The report carries `agent_id` but not the agent's name, so the join happens
 * here rather than in every table that renders one.
 *
 * An id can legitimately be missing from the directory: the report is a
 * historical snapshot, and an agent who worked during that window may have been
 * deleted since. That row still holds real hours and must stay visible, so it
 * falls back to `Agent #<id>` — dropping it would silently understate the
 * period's total, and rendering `undefined` would look like a bug.
 */
export function useReportRows(report: ReportDTO | undefined): ReportRow[] {
  const { data: agents } = useAgents()

  return useMemo(() => {
    if (!report) return []

    const namesById = new Map(agents?.map((agent) => [agent.id, agent.name] as const) ?? [])

    return report.agent_hours.map((hours) => ({
      agentId: hours.agent_id,
      agentName: namesById.get(hours.agent_id) ?? `Agent #${hours.agent_id}`,
      businessSeconds: hours.business_seconds,
    }))
  }, [report, agents])
}
