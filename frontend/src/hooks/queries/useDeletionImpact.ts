import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { DeletionImpactDTO } from '@/api/types'
import { queryKeys } from '@/hooks/queryKeys'

const NO_SELECTION = -1

/**
 * Deliberately lazy. Impact is only meaningful at the moment the user opens the
 * delete confirmation, so the caller passes `null` until then — rendering a
 * hundred-row schedule list must not fire a hundred impact requests, and a
 * pre-fetched answer would be stale by the time it is read.
 */
export function useDeletionImpact(id: number | null): UseQueryResult<DeletionImpactDTO, ApiError> {
  return useQuery<DeletionImpactDTO, ApiError>({
    queryKey: queryKeys.schedules.deletionImpact(id ?? NO_SELECTION),
    queryFn: () => apiService.schedules.deletionImpact(id as number),
    enabled: id !== null,
    // Impact must reflect assignments as they are right now, not as they were
    // when the list was last loaded.
    staleTime: 0,
  })
}
