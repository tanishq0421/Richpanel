import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { ScheduleDTO, ShiftDTO } from '@/api/types'
import { queryKeys } from '@/hooks/queryKeys'

export interface CreateScheduleInput {
  name: string
  start_date: string
  end_date: string | null
  shifts: ShiftDTO[]
}

export function useCreateSchedule(): UseMutationResult<ScheduleDTO, ApiError, CreateScheduleInput> {
  const queryClient = useQueryClient()

  return useMutation<ScheduleDTO, ApiError, CreateScheduleInput>({
    mutationFn: (input) => apiService.schedules.create(input),
    onSuccess: (schedule) => {
      // The list gains a row, and the detail key for the new id must not serve
      // a stale placeholder if anything raced ahead and rendered it.
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules.list() })
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules.detail(schedule.id) })
    },
  })
}
