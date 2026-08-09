import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import { queryKeys } from '@/hooks/queryKeys'

export interface AssignmentInput {
  scheduleId: number
  agentId: number
}

/** Rejects with a 409 (`kind: 'conflict'`) when the agent's hours would overlap
 *  another of their schedules, or when they are already assigned here. That is
 *  an expected rejection — show it inline, not as a fault. */
export function useAssignAgent(): UseMutationResult<void, ApiError, AssignmentInput> {
  const queryClient = useQueryClient()

  return useMutation<void, ApiError, AssignmentInput>({
    mutationFn: ({ scheduleId, agentId }) => apiService.assignments.assign(scheduleId, agentId),
    onSuccess: (_result, { scheduleId, agentId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules.assignees(scheduleId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.schedules(agentId) })
      // Reports are NOT invalidated. A report is a point-in-time snapshot of
      // hours already worked over a past ticket window; changing coverage now
      // cannot change what a past report measured. Invalidating here would
      // refetch identical data and, worse, imply to the user that the numbers
      // they are reading move when they assign someone.
    },
  })
}
