import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import { queryKeys } from '@/hooks/queryKeys'
import type { AssignmentInput } from './useAssignAgent'

export function useUnassignAgent(): UseMutationResult<void, ApiError, AssignmentInput> {
  const queryClient = useQueryClient()

  return useMutation<void, ApiError, AssignmentInput>({
    mutationFn: ({ scheduleId, agentId }) => apiService.assignments.unassign(scheduleId, agentId),
    onSuccess: (_result, { scheduleId, agentId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules.assignees(scheduleId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.schedules(agentId) })
      // Reports are NOT invalidated — same reason as in `useAssignAgent`: a
      // report is a point-in-time snapshot of a past window, so today's
      // coverage change cannot alter it.
    },
  })
}
