import { describe, expect, it } from 'vitest'
import {
  formatBusinessSeconds,
  hhmmToHours,
  hoursToHHMM,
  isOvernight,
  shiftDurationHours,
  timeOptions,
  toNaiveIsoDateTime,
} from './time'

describe('float hours <-> HH:MM', () => {
  it.each([
    [9, '09:00'],
    [22.5, '22:30'],
    [0, '00:00'],
    [23.75, '23:45'],
    [13.25, '13:15'],
    [24, '24:00'],
  ])('formats %s as %s', (hours, expected) => {
    expect(hoursToHHMM(hours)).toBe(expected)
  })

  it('parses 24:00 back to 24 hours', () => {
    expect(hhmmToHours('24:00')).toBe(24)
  })

  it('round-trips every option the picker offers', () => {
    for (const option of timeOptions()) {
      expect(hoursToHHMM(hhmmToHours(option))).toBe(option)
    }
  })
})

describe('overnight detection', () => {
  it('treats an end before the start as crossing midnight', () => {
    expect(isOvernight(22, 6)).toBe(true)
  })

  it('treats a same-day shift as not overnight', () => {
    expect(isOvernight(9, 17)).toBe(false)
  })

  it('treats equal start and end as overnight, matching the backend rule', () => {
    // The backend rejects this as zero-duration (422); the UI must not silently
    // render it as a 0-hour same-day shift.
    expect(isOvernight(9, 9)).toBe(true)
  })
})

describe('shift duration', () => {
  it('measures a same-day shift', () => {
    expect(shiftDurationHours(9, 17)).toBe(8)
  })

  it('measures across midnight', () => {
    expect(shiftDurationHours(22, 6)).toBe(8)
  })
})

describe('formatBusinessSeconds', () => {
  it.each([
    [0, '0h'],
    [8 * 3600, '8h'],
    [7.5 * 3600, '7h 30m'],
    [45 * 60, '45m'],
    [88 * 3600, '88h'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatBusinessSeconds(seconds)).toBe(expected)
  })
})

describe('toNaiveIsoDateTime', () => {
  it('emits a naive datetime with no offset', () => {
    // Critical: the backend interprets naive input as IST. Sending a UTC
    // instant would shift the window by 5h30m and change every reported figure.
    expect(toNaiveIsoDateTime(new Date(2026, 0, 6), '10:00')).toBe('2026-01-06T10:00:00')
    expect(toNaiveIsoDateTime(new Date(2026, 0, 6), '10:00')).not.toContain('Z')
  })
})
