import type { ApiErrorBody, ValidationDetail } from './types'

const BASE_URL = (import.meta.env.VITE_APP_BASE_URL ?? 'http://localhost:8000').replace(/\/$/, '')

/** Requests are abandoned after this long. Without it a hung backend leaves the
 *  UI spinning forever with no way to distinguish "slow" from "dead". */
const TIMEOUT_MS = 20_000

/**
 * Every failure the UI can encounter, as one type. Callers switch on `kind`
 * rather than sniffing status codes in a dozen places.
 *
 *  - `validation` (422) carries per-field details, so a form maps each message
 *    back onto the control that caused it.
 *  - `conflict` (409) is a business-rule rejection — an overlapping schedule or
 *    an already-assigned agent — and is expected, not exceptional.
 *  - `network` and `timeout` are the cases a naive client forgets; the API is
 *    on a different origin and port, so they are entirely reachable.
 */
export type ApiErrorKind =
  | 'validation'
  | 'conflict'
  | 'not_found'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'timeout'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number
  readonly code: string
  readonly details: ValidationDetail[]

  constructor(kind: ApiErrorKind, status: number, code: string, message: string, details: ValidationDetail[] = []) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.code = code
    this.details = details
  }

  /** The message for a given form field, if this was a validation failure.
   *  Matches on prefix so `shifts.0` also surfaces on `shifts.0.start_hours`. */
  fieldError(field: string): string | undefined {
    return this.details.find((d) => d.field === field || d.field.startsWith(`${field}.`))?.message
  }

  /**
   * The message for a whole-request (model-level) validation failure, as
   * opposed to one attributable to a single field.
   *
   * A Pydantic `@model_validator` that compares more than one field together
   * (end_date vs start_date, a report window vs "now") can only address the
   * object being validated, not a member of it, so FastAPI reports it with
   * `field: "body"` rather than a field name. `fieldError('some_field')`
   * cannot find this — it was first found missing on the report form (a 422
   * whose details all lived under "body" produced no field error AND no
   * generic banner, since a validation error with any details at all
   * suppressed the fallback: the request was correctly rejected and the UI
   * said nothing). Centralised here — rather than reimplemented per form —
   * because that bug is exactly as likely on any OTHER model-level validator
   * (there are several: schedule name/dates, one-window-per-weekday) unless
   * every form remembers to check for it independently.
   */
  get bodyError(): string | undefined {
    return this.fieldError('body')
  }

  /** Retrying is only sensible for transient transport/server failures — never
   *  for a 4xx, which will fail identically until the input changes. */
  get isRetryable(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'server'
  }
}

function kindForStatus(status: number): ApiErrorKind {
  if (status === 422) return 'validation'
  if (status === 409) return 'conflict'
  if (status === 404) return 'not_found'
  if (status === 400) return 'bad_request'
  return 'server'
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
  } catch (cause) {
    // A CORS rejection also lands here, indistinguishable from being offline —
    // the browser deliberately withholds the reason. Worth remembering when the
    // API "goes silent" after a deploy: check CORS_ALLOWED_ORIGINS first.
    const aborted = cause instanceof DOMException && cause.name === 'AbortError'
    throw new ApiError(
      aborted ? 'timeout' : 'network',
      0,
      aborted ? 'timeout' : 'network_error',
      aborted ? 'The request took too long. Check your connection and try again.' : 'Could not reach the server.',
    )
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 204) return undefined as T

  if (!response.ok) {
    let body: Partial<ApiErrorBody> = {}
    try {
      body = await response.json()
    } catch {
      /* non-JSON error page (proxy, gateway) — fall through to defaults */
    }
    throw new ApiError(
      kindForStatus(response.status),
      response.status,
      body.error_code ?? 'unknown',
      body.message ?? `Request failed (${response.status})`,
      body.details ?? [],
    )
  }

  return (await response.json()) as T
}

export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}
