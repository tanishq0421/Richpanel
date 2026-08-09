// Mirrors the backend contract exactly. Verified against
// backend/app/api/v1/*/request_response.py — do not drift from it.

/** 0 = Monday … 6 = Sunday, matching Python's `date.weekday()`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/**
 * Hours are floats on the wire: 22.5 means 22:30.
 * `end_hours < start_hours` means the shift crosses midnight.
 * `end_hours === 0` is rejected by the backend (422) — a shift ending at
 * midnight is not supported.
 */
export interface ShiftDTO {
  weekday: Weekday
  start_hours: number
  end_hours: number
}

export interface ScheduleDTO {
  id: number
  name: string
  start_date: string // ISO date, IST
  end_date: string | null
  shifts: ShiftDTO[]
}

export interface AgentDTO {
  id: number
  name: string
  email: string | null
}

/** Only id + name — the assignment endpoints return a narrower shape. */
export interface AgentSummaryDTO {
  id: number
  name: string
}

export interface ScheduleSummaryDTO {
  id: number
  name: string
}

export interface DeletionImpactDTO {
  schedule_id: number
  affected_agent_ids: number[]
}

/**
 * Note the report carries `agent_id` but NOT the agent's name — the client
 * joins against the agents list. See `useReportRows`.
 */
export interface AgentHoursDTO {
  agent_id: number
  business_seconds: number
}

export interface ReportDTO {
  id: number
  ticket_start_at: string // ISO datetime with +05:30 offset
  ticket_end_at: string
  /** Always empty in the LIST view — absence of data, not zero hours. */
  agent_hours: AgentHoursDTO[]
}

// ── Errors ─────────────────────────────────────────────────────────────────

/** Field-level detail on a 422. `field` is addressable within the request
 *  payload, e.g. `shifts.0` or `shifts.0.start_hours`. */
export interface ValidationDetail {
  field: string
  message: string
  type: string
}

export interface ApiErrorBody {
  error_code: string
  message: string
  details?: ValidationDetail[]
}

export interface PaginationParams {
  limit?: number
  offset?: number
}
