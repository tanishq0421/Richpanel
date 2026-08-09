import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { ReportDTO } from '@/api/types'
import { queryKeys } from '@/hooks/queryKeys'

const NO_SELECTION = -1

/**
 * A report is a point-in-time snapshot: once generated its numbers never
 * change, so it is worth holding rather than re-fetching on every mount.
 */
export function useReport(id: number | null): UseQueryResult<ReportDTO, ApiError> {
  return useQuery<ReportDTO, ApiError>({
    queryKey: queryKeys.reports.detail(id ?? NO_SELECTION),
    queryFn: () => apiService.reports.get(id as number),
    enabled: id !== null,
    staleTime: Infinity,
  })
}
