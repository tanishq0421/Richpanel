import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { ReportDTO } from '@/api/types'
import { queryKeys } from '@/hooks/queryKeys'

export interface GenerateReportInput {
  ticketStartAt: string
  ticketEndAt: string
}

export function useGenerateReport(): UseMutationResult<ReportDTO, ApiError, GenerateReportInput> {
  const queryClient = useQueryClient()

  return useMutation<ReportDTO, ApiError, GenerateReportInput>({
    mutationFn: ({ ticketStartAt, ticketEndAt }) => apiService.reports.generate(ticketStartAt, ticketEndAt),
    onSuccess: () => {
      // Only the list changes: a new snapshot exists. Existing report details
      // are immutable, so nothing else is touched.
      queryClient.invalidateQueries({ queryKey: queryKeys.reports.list() })
    },
  })
}
