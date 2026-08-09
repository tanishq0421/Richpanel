import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { ScheduleSummaryDTO } from '@/api/types'
import { queryKeys } from '@/hooks/queryKeys'

/**
 * Deleting a schedule is the one mutation whose server-side effect fans out
 * beyond the entity named in the request: `soft_delete_schedule` cascades to
 * `soft_delete_assignments_for_schedule`, so a single DELETE performs N
 * unassignments. The 204 response carries no body, so the client is not told
 * whose assignments went with it.
 *
 * Invalidation is therefore worked out case-wise — which cached queries could
 * this write have falsified?
 *
 *   schedules.list()            YES  the schedule leaves the list
 *   schedules.detail(id)        YES  invalidated rather than removed, so anything
 *                                    still mounted refetches, 404s, and says so
 *   schedules.assignees(id)     YES  the cascade soft-deleted every assignment
 *   agents.schedules(agentId)   YES  but only for agents who were on THIS schedule
 *   agents.list()               no   the agents themselves are unchanged
 *   reports.*                   no   a report is a point-in-time snapshot of a past
 *                                    window; today's coverage change cannot alter it
 *
 * The affected agents are identified from the CACHE rather than from
 * `useDeletionImpact`. That is deliberate: the impact list is fetched when the
 * confirmation dialog opens, and someone may assign another agent between that
 * fetch and the confirm — invalidating from it would miss them. Every cached
 * agent-schedule list that mentions this schedule is stale by definition, and
 * one that does not mention it is not affected. The cache is the honest source.
 */
export function useDeleteSchedule(): UseMutationResult<void, ApiError, number> {
  const queryClient = useQueryClient()

  return useMutation<void, ApiError, number>({
    mutationFn: (id) => apiService.schedules.remove(id),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules.list() })
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules.detail(id) })
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules.assignees(id) })

      queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey
          // queryKeys.agents.schedules(agentId) === ['agents', agentId, 'schedules']
          const isAgentSchedules = key[0] === 'agents' && key[2] === 'schedules'
          if (!isAgentSchedules) return false

          const cached = query.state.data as ScheduleSummaryDTO[] | undefined
          // No data yet (loading, errored, or evicted) means we cannot rule the
          // query out — invalidate rather than risk leaving it stale.
          if (cached === undefined) return true
          return cached.some((schedule) => schedule.id === id)
        },
      })
    },
  })
}
