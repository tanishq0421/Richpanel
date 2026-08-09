import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { ScheduleSummaryDTO } from '@/api/types'
import { queryKeys } from '@/hooks/queryKeys'

const NO_SELECTION = -1

export function useAgentSchedules(agentId: number | null): UseQueryResult<ScheduleSummaryDTO[], ApiError> {
  return useQuery<ScheduleSummaryDTO[], ApiError>({
    queryKey: queryKeys.agents.schedules(agentId ?? NO_SELECTION),
    queryFn: () => apiService.agents.schedulesFor(agentId as number),
    enabled: agentId !== null,
  })
}
