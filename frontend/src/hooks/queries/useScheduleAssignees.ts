import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { AgentSummaryDTO } from '@/api/types'
import { queryKeys } from '@/hooks/queryKeys'

const NO_SELECTION = -1

export function useScheduleAssignees(id: number | null): UseQueryResult<AgentSummaryDTO[], ApiError> {
  return useQuery<AgentSummaryDTO[], ApiError>({
    queryKey: queryKeys.schedules.assignees(id ?? NO_SELECTION),
    queryFn: () => apiService.assignments.listAssignees(id as number),
    enabled: id !== null,
  })
}
