/**
 * The wire format for shift hours is a float: 22.5 means 22:30. Every
 * conversion goes through here rather than being reimplemented in each picker —
 * the same reasoning as the backend's services/_conversions.py.
 */

/** Minutes the time picker offers. 15 keeps the wire value exactly
 *  representable as a float (x.0 / x.25 / x.5 / x.75) with no rounding drift. */
export const MINUTE_STEP = 15

export function hoursToHHMM(hours: number): string {
  const totalMinutes = Math.round(hours * 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function hhmmToHours(value: string): number {
  const [h, m] = value.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) throw new Error(`invalid time: ${value}`)
  return h + m / 60
}

/**
 * A shift crosses midnight when it ends at or before it starts. The backend
 * stores this split across two weekdays, but the user always enters and reads
 * it as one continuous shift.
 */
export function isOvernight(startHours: number, endHours: number): boolean {
  return endHours <= startHours
}

/** Duration in hours, accounting for the midnight wrap. */
export function shiftDurationHours(startHours: number, endHours: number): number {
  return isOvernight(startHours, endHours) ? 24 - startHours + endHours : endHours - startHours
}

/** Every quarter-hour of the day, for the time picker. */
export function timeOptions(step = MINUTE_STEP): string[] {
  const out: string[] = []
  for (let minutes = 0; minutes < 24 * 60; minutes += step) {
    out.push(hoursToHHMM(minutes / 60))
  }
  return out
}

/**
 * `business_seconds` → what a support manager actually reads. Deliberately not
 * decimal hours: "7h 30m" is unambiguous where "7.5" invites the reader to
 * wonder whether it means 7h50m.
 */
export function formatBusinessSeconds(seconds: number): string {
  if (seconds === 0) return '0h'
  const totalMinutes = Math.round(seconds / 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (m === 0) return `${h}h`
  if (h === 0) return `${m}m`
  return `${h}h ${m}m`
}

/**
 * The backend interprets a naive datetime as IST, so we deliberately send a
 * naive string rather than an ISO instant. Converting to UTC here would shift
 * the wall-clock window by 5h30m and silently change every reported figure.
 */
export function toNaiveIsoDateTime(date: Date, time: string): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}T${time}:00`
}

export function toIsoDate(date: Date): string {
  return toNaiveIsoDateTime(date, '00:00').slice(0, 10)
}
