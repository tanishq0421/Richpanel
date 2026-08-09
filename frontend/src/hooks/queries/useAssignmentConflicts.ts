import { useCallback } from 'react'
import { keepPreviousData, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { AgentConflictDTO } from '@/api/types'
import { queryKeys } from '@/hooks/queryKeys'

const NO_SELECTION = -1

/**
 * Who, of the agents offered, the backend would refuse to assign to this
 * schedule — and why. The overlap rule lives in the backend domain layer and is
 * deliberately not reimplemented here: a second copy would drift from the
 * first, and the client cannot see the other schedules an agent holds anyway.
 *
 * Lazy in the same way as `useDeletionImpact`. The caller passes `null` until
 * the picker is actually open, and an empty id list until the directory has
 * loaded, so nothing is asked before there is a question to ask.
 *
 * `staleTime: 0` because the answer is about other people's schedules, which
 * anyone can change: a cached "no conflicts" from a minute ago is a guess.
 *
 * `keepPreviousData` because the id set shrinks as agents get assigned. Without
 * it every such change would blank the list back to a skeleton mid-flow; with
 * it the last answer stays on screen until the next one lands.
 */
export function useAssignmentConflicts(
  scheduleId: number | null,
  agentIds: number[],
): UseQueryResult<AgentConflictDTO[], ApiError> {
  // Sorted so that {6,5} and {5,6} are one cache entry rather than two
  // identical round-trips — the picker's order is a view concern.
  const ids = [...agentIds].sort((a, b) => a - b)

  return useQuery<AgentConflictDTO[], ApiError>({
    queryKey: queryKeys.schedules.assignmentCheck(scheduleId ?? NO_SELECTION, ids),
    queryFn: () => apiService.assignments.check(scheduleId as number, ids).then((body) => body.conflicts),
    enabled: scheduleId !== null && ids.length > 0,
    staleTime: 0,
    placeholderData: keepPreviousData,
  })
}

/**
 * Falsify every conflict answer held for this schedule.
 *
 * Resolving a conflict means writing to a *different* schedule, so no mutation
 * in the assignment layer can know this key — the caller invalidates it after
 * the write. Invalidation rather than a local edit is the point: the check is
 * the only source of truth for who conflicts, so the row unlocks because the
 * backend said so on a second look, not because the UI assumed it would.
 */
export function useRecheckAssignmentConflicts(scheduleId: number | null): () => void {
  const queryClient = useQueryClient()

  return useCallback(() => {
    if (scheduleId === null) return
    void queryClient.invalidateQueries({ queryKey: queryKeys.schedules.assignmentChecks(scheduleId) })
  }, [queryClient, scheduleId])
}
