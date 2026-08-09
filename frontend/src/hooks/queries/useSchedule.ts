import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { ScheduleDTO } from '@/api/types'
import { queryKeys } from '@/hooks/queryKeys'

/**
 * `id` is nullable because the caller is usually a detail panel driven by a
 * selection that starts empty. A sentinel keeps the key well-formed while the
 * query is disabled; it is never fetched, so it can never collide with real
 * data.
 */
const NO_SELECTION = -1

export function useSchedule(id: number | null): UseQueryResult<ScheduleDTO, ApiError> {
  return useQuery<ScheduleDTO, ApiError>({
    queryKey: queryKeys.schedules.detail(id ?? NO_SELECTION),
    queryFn: () => apiService.schedules.get(id as number),
    enabled: id !== null,
  })
}
