import { query, request } from './http'
import type {
  AgentDTO,
  AgentSummaryDTO,
  DeletionImpactDTO,
  PaginationParams,
  ReportDTO,
  ScheduleDTO,
  ScheduleSummaryDTO,
  ShiftDTO,
} from './types'

/**
 * The single place that knows API routes and shapes. Grouped by resource so a
 * call site reads `apiService.schedules.create(...)`.
 *
 * Components never import this — hooks do. That keeps every component
 * renderable in isolation and keeps refetching/caching policy in one layer.
 */
class ApiService {
  readonly agents = {
    list: (params: PaginationParams = {}) =>
      request<AgentDTO[]>(`/api/v1/agents${query({ limit: params.limit, offset: params.offset })}`),

    schedulesFor: (agentId: number) => request<ScheduleSummaryDTO[]>(`/api/v1/agents/${agentId}/schedules`),
  }

  readonly schedules = {
    list: (params: PaginationParams = {}) =>
      request<ScheduleDTO[]>(`/api/v1/schedules${query({ limit: params.limit, offset: params.offset })}`),

    get: (id: number) => request<ScheduleDTO>(`/api/v1/schedules/${id}`),

    create: (input: { name: string; start_date: string; end_date: string | null; shifts: ShiftDTO[] }) =>
      request<ScheduleDTO>('/api/v1/schedules', { method: 'POST', body: JSON.stringify(input) }),

    /** Hours only — name and dates are not editable through the API today. */
    updateHours: (id: number, shifts: ShiftDTO[]) =>
      request<ScheduleDTO>(`/api/v1/schedules/${id}`, { method: 'PUT', body: JSON.stringify({ shifts }) }),

    /** Who loses coverage if this schedule is deleted. Must be shown to the
     *  user BEFORE they confirm — deleting silently can zero out coverage for
     *  dozens of agents with no warning until reports look wrong. */
    deletionImpact: (id: number) => request<DeletionImpactDTO>(`/api/v1/schedules/${id}/deletion-impact`),

    remove: (id: number) => request<void>(`/api/v1/schedules/${id}`, { method: 'DELETE' }),
  }

  readonly assignments = {
    listAssignees: (scheduleId: number) => request<AgentSummaryDTO[]>(`/api/v1/schedules/${scheduleId}/agents`),

    /** 409 when the agent's hours would overlap another of their schedules,
     *  or when they are already assigned here. */
    assign: (scheduleId: number, agentId: number) =>
      request<void>(`/api/v1/schedules/${scheduleId}/agents`, {
        method: 'POST',
        body: JSON.stringify({ agent_id: agentId }),
      }),

    unassign: (scheduleId: number, agentId: number) =>
      request<void>(`/api/v1/schedules/${scheduleId}/agents/${agentId}`, { method: 'DELETE' }),
  }

  readonly reports = {
    /** Datetimes are sent without an offset and interpreted as IST by the
     *  backend, which pins the system timezone. Responses come back with the
     *  +05:30 offset attached. */
    generate: (ticketStartAt: string, ticketEndAt: string) =>
      request<ReportDTO>('/api/v1/reports', {
        method: 'POST',
        body: JSON.stringify({ ticket_start_at: ticketStartAt, ticket_end_at: ticketEndAt }),
      }),

    list: (params: PaginationParams = {}) =>
      request<ReportDTO[]>(`/api/v1/reports${query({ limit: params.limit, offset: params.offset })}`),

    get: (id: number) => request<ReportDTO>(`/api/v1/reports/${id}`),
  }
}

export const apiService = new ApiService()
