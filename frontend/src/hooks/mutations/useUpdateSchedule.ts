import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { ScheduleDTO, ShiftDTO } from '@/api/types'
import { queryKeys } from '@/hooks/queryKeys'

export interface UpdateScheduleInput {
  id: number
  name?: string
  start_date?: string
  end_date?: string | null
  shifts: ShiftDTO[]
}

export function useUpdateSchedule(): UseMutationResult<ScheduleDTO, ApiError, UpdateScheduleInput> {
  const queryClient = useQueryClient()

  return useMutation<ScheduleDTO, ApiError, UpdateScheduleInput>({
    mutationFn: ({ id, ...input }) => apiService.schedules.update(id, input),
    onSuccess: (_schedule, { id }) => {
      // Name/dates/shifts are all on the same schedule resource and are
      // embedded in the list rows as well as in the detail, so both go stale
      // on any successful write here — no need to distinguish which fields
      // changed.
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules.list() })
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules.detail(id) })
    },
  })
}
