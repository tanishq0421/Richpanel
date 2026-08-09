import type { Weekday } from '@/api/types'

/** Index 0 = Monday, matching Python's `date.weekday()`. Getting this wrong
 *  shifts every schedule by a day, so it is defined once, here. */
export const WEEKDAYS: { value: Weekday; short: string; long: string }[] = [
  { value: 0, short: 'Mon', long: 'Monday' },
  { value: 1, short: 'Tue', long: 'Tuesday' },
  { value: 2, short: 'Wed', long: 'Wednesday' },
  { value: 3, short: 'Thu', long: 'Thursday' },
  { value: 4, short: 'Fri', long: 'Friday' },
  { value: 5, short: 'Sat', long: 'Saturday' },
  { value: 6, short: 'Sun', long: 'Sunday' },
]

export function weekdayLong(value: Weekday): string {
  return WEEKDAYS[value].long
}

export function weekdayShort(value: Weekday): string {
  return WEEKDAYS[value].short
}

/** The weekday an overnight shift spills into — Sunday wraps to Monday. */
export function nextWeekday(value: Weekday): Weekday {
  return ((value + 1) % 7) as Weekday
}
