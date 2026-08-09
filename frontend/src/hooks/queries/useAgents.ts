import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { AgentDTO } from '@/api/types'
import { queryKeys } from '@/hooks/queryKeys'

/**
 * The full agent directory. Cached under one key and reused by the assignment
 * picker and by `useReportRows`, which needs it to turn `agent_id` into a name.
 */
export function useAgents(): UseQueryResult<AgentDTO[], ApiError> {
  return useQuery<AgentDTO[], ApiError>({
    queryKey: queryKeys.agents.list(),
    queryFn: () => apiService.agents.list(),
  })
}
