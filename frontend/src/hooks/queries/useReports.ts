import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { ReportDTO } from '@/api/types'
import { queryKeys } from '@/hooks/queryKeys'

/** List rows always carry an empty `agent_hours` — read a row's numbers with
 *  `useReport`, never from this list. */
export function useReports(): UseQueryResult<ReportDTO[], ApiError> {
  return useQuery<ReportDTO[], ApiError>({
    queryKey: queryKeys.reports.list(),
    queryFn: () => apiService.reports.list(),
  })
}
