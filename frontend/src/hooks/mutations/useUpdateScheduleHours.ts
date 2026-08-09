import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { ScheduleDTO, ShiftDTO } from '@/api/types'
import { queryKeys } from '@/hooks/queryKeys'

export interface UpdateScheduleHoursInput {
  id: number
  shifts: ShiftDTO[]
}

export function useUpdateScheduleHours(): UseMutationResult<ScheduleDTO, ApiError, UpdateScheduleHoursInput> {
  const queryClient = useQueryClient()

  return useMutation<ScheduleDTO, ApiError, UpdateScheduleHoursInput>({
    mutationFn: ({ id, shifts }) => apiService.schedules.updateHours(id, shifts),
    onSuccess: (_schedule, { id }) => {
      // Shifts are embedded in the list rows as well as in the detail, so both
      // go stale on a successful write.
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules.list() })
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules.detail(id) })
    },
  })
}
