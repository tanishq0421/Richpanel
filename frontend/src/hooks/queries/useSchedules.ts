import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { ScheduleDTO } from '@/api/types'
import { queryKeys } from '@/hooks/queryKeys'

export function useSchedules(): UseQueryResult<ScheduleDTO[], ApiError> {
  return useQuery<ScheduleDTO[], ApiError>({
    queryKey: queryKeys.schedules.list(),
    queryFn: () => apiService.schedules.list(),
  })
}
