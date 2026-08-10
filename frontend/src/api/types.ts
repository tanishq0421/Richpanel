// Mirrors the backend contract exactly. Verified against
// backend/app/api/v1/*/request_response.py — do not drift from it.

/** 0 = Monday … 6 = Sunday, matching Python's `date.weekday()`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/**
 * Hours are floats on the wire: 22.5 means 22:30. `end_hours` may reach 24
 * (same-day, ending exactly at midnight); `start_hours` may not.
 * `end_hours < start_hours` means the shift crosses midnight.
 * The backend rejects (422): `end_hours === 0` (ambiguous -- use 24 instead),
 * `start_hours === end_hours`, and `start_hours === 0 && end_hours === 24`
 * (both spellings of round-the-clock).
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

/**
 * `PUT /schedules/{id}` body. `shifts` is always required; `name`/`start_date`/
 * `end_date` are a partial update — a key that is OMITTED from the object
 * means "leave this field unchanged," while `end_date: null` explicitly means
 * "clear it, make the schedule ongoing." Those are different states on the
 * wire, and `end_date?: string | null` is enough to keep them distinguishable
 * without any extra serialization step: `JSON.stringify` already drops a key
 * whose value is `undefined` (the "don't set this property" case) while
 * keeping an explicit `null`, so a caller only has to leave the key off the
 * object to mean "unchanged" and set it to `null` to mean "ongoing."
 */
export interface UpdateScheduleRequest {
  name?: string
  start_date?: string
  end_date?: string | null
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

// ── Assignment conflict pre-check ──────────────────────────────────────────

/**
 * One weekday on which the agent's existing shift and the shift this schedule
 * would add overlap. Both pairs are hours-as-floats, the same convention as
 * `ShiftDTO` — 22.5 is 22:30.
 *
 * `existing_*` is what the agent already works elsewhere, which is the pair
 * worth showing: it names the commitment the user has to go and change.
 */
export interface CollidingShiftDTO {
  weekday: Weekday
  existing_start_hours: number
  existing_end_hours: number
  new_start_hours: number
  new_end_hours: number
}

/** The *other* schedule holding the agent, addressable so the UI can offer to
 *  unassign them from it. */
export interface ScheduleConflictDTO {
  schedule_id: number
  schedule_name: string
  colliding_shifts: CollidingShiftDTO[]
}

/** `agent_name` is carried so the UI never has to re-join against the
 *  directory to say who is blocked. One agent can be blocked by several
 *  schedules at once, hence the list. */
export interface AgentConflictDTO {
  agent_id: number
  agent_name: string
  conflicts: ScheduleConflictDTO[]
}

/**
 * Response of `POST /schedules/{id}/agents/check`. Agents ABSENT from
 * `conflicts` are assignable.
 *
 * The check writes nothing and is advisory: state can change between the check
 * and the write, so `assign` can still answer 409.
 */
export interface AssignmentCheckDTO {
  conflicts: AgentConflictDTO[]
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
