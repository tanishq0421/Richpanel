import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ShiftDTO } from '@/api/types'
import { WeeklyHoursEditor } from './WeeklyHoursEditor'

/**
 * TimePicker is stubbed as a bare text input. What is under test here is the
 * ribbon's arithmetic and its rules — HH:MM to float, the midnight crossing,
 * the two rejected shapes — not how another component renders a dropdown.
 * Driving the real picker's internals would couple these tests to a UI decision
 * that has nothing to do with any of that.
 */
vi.mock('@/components/datetime/TimePicker', () => ({
  TimePicker: (props: {
    value: string
    onChange: (v: string) => void
    disabled?: boolean
    'aria-label'?: string
  }) => (
    <input
      type="text"
      aria-label={props['aria-label']}
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}))

/** The editor is controlled, so the test owns the state it edits — otherwise
 *  nothing the user does would ever be reflected back into `value`. */
function Harness({
  initial = [],
  onChange,
  disabled,
}: {
  initial?: ShiftDTO[]
  onChange?: (shifts: ShiftDTO[]) => void
  disabled?: boolean
}) {
  const [shifts, setShifts] = useState<ShiftDTO[]>(initial)
  return (
    <WeeklyHoursEditor
      value={shifts}
      disabled={disabled}
      onChange={(next) => {
        setShifts(next)
        onChange?.(next)
      }}
    />
  )
}

const setTime = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('WeeklyHoursEditor — one window per weekday', () => {
  it('offers exactly seven days and no way to add a second window', () => {
    render(<Harness />)
    expect(screen.getAllByRole('switch')).toHaveLength(7)
    expect(screen.queryByRole('button', { name: /add (another )?(window|shift|break)/i })).toBeNull()
  })

  it('emits a shift when a day is switched on', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await user.click(screen.getByRole('switch', { name: 'Work on Monday' }))

    expect(onChange).toHaveBeenCalledWith([{ weekday: 0, start_hours: 9, end_hours: 17 }])
  })

  it('removes only that day when it is switched off', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Harness
        onChange={onChange}
        initial={[
          { weekday: 0, start_hours: 9, end_hours: 17 },
          { weekday: 1, start_hours: 9, end_hours: 17 },
        ]}
      />,
    )

    await user.click(screen.getByRole('switch', { name: 'Work on Tuesday' }))

    expect(onChange).toHaveBeenCalledWith([{ weekday: 0, start_hours: 9, end_hours: 17 }])
  })
})

describe('WeeklyHoursEditor — HH:MM to wire floats', () => {
  it('converts 22:30 to 22.5', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} initial={[{ weekday: 0, start_hours: 9, end_hours: 17 }]} />)

    setTime('Monday start time', '22:30')

    expect(onChange).toHaveBeenCalledWith([{ weekday: 0, start_hours: 22.5, end_hours: 17 }])
  })

  it('converts a quarter-hour end to 23.75', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} initial={[{ weekday: 4, start_hours: 9, end_hours: 17 }]} />)

    setTime('Friday end time', '23:45')

    expect(onChange).toHaveBeenCalledWith([{ weekday: 4, start_hours: 9, end_hours: 23.75 }])
  })

  it('announces a row as one sentence, with its length', () => {
    render(<Harness initial={[{ weekday: 0, start_hours: 9, end_hours: 17 }]} />)
    expect(screen.getByRole('group', { name: 'Monday, 09:00 to 17:00, 8 hours' })).toBeInTheDocument()
  })
})

describe('WeeklyHoursEditor — overnight shifts are one shift', () => {
  it('marks the owning day as crossing midnight and continues it onto the next weekday', () => {
    render(<Harness initial={[{ weekday: 0, start_hours: 22, end_hours: 6 }]} />)

    // One shift, 8 hours long — not two four-hour fragments.
    expect(screen.getByRole('group', { name: 'Monday, 22:00 to 06:00 the next day, 8 hours' })).toBeInTheDocument()

    // Tuesday is not worked, yet is covered until 06:00 by Monday's shift.
    expect(
      screen.getByRole('group', { name: "Tuesday, not worked. Monday's shift continues until 06:00." }),
    ).toBeInTheDocument()

    // The continuation stops after one day.
    expect(screen.getByRole('group', { name: 'Wednesday, not worked' })).toBeInTheDocument()
  })

  it("wraps Sunday's overnight shift onto Monday", () => {
    render(<Harness initial={[{ weekday: 6, start_hours: 22, end_hours: 6 }]} />)

    expect(screen.getByRole('group', { name: 'Sunday, 22:00 to 06:00 the next day, 8 hours' })).toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: "Monday, not worked. Sunday's shift continues until 06:00." }),
    ).toBeInTheDocument()
  })

  it('shows a continuation even when the next day has a shift of its own', () => {
    render(
      <Harness
        initial={[
          { weekday: 0, start_hours: 22, end_hours: 6 },
          { weekday: 1, start_hours: 9, end_hours: 17 },
        ]}
      />,
    )

    expect(
      screen.getByRole('group', {
        name: "Tuesday, 09:00 to 17:00, 8 hours. Monday's shift continues until 06:00.",
      }),
    ).toBeInTheDocument()
  })
})

describe('WeeklyHoursEditor — an overnight tail colliding with its own landing day', () => {
  it('warns when the tail overlaps that weekday\'s own configured shift, naming the day and the window', () => {
    // The exact case from find_self_overlaps' docstring: Sunday 22:00-06:00's
    // tail lands on Monday 00:00-06:00, and Monday has its own 03:00-11:00.
    render(
      <Harness
        initial={[
          { weekday: 6, start_hours: 22, end_hours: 6 },
          { weekday: 0, start_hours: 3, end_hours: 11 },
        ]}
      />,
    )

    const warning = screen.getByRole('alert')
    expect(warning).toHaveTextContent("Overlaps Sunday's overnight shift here, 03:00–06:00")
  })

  it('does not warn when the continuation ends before the next day\'s own shift starts', () => {
    render(
      <Harness
        initial={[
          { weekday: 6, start_hours: 22, end_hours: 3 },
          { weekday: 0, start_hours: 5, end_hours: 11 },
        ]}
      />,
    )

    expect(screen.queryByText(/overlaps sunday/i)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not false-positive on an ordinary overnight shift with nothing configured on the day it lands on', () => {
    render(<Harness initial={[{ weekday: 0, start_hours: 22, end_hours: 6 }]} />)

    expect(screen.queryByText(/overlaps/i)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('blocks committing an edit that would create the collision, leaving the typed value on screen', async () => {
    const onChange = vi.fn()
    render(
      <Harness
        onChange={onChange}
        initial={[
          { weekday: 6, start_hours: 22, end_hours: 6 },
          { weekday: 0, start_hours: 9, end_hours: 17 },
        ]}
      />,
    )

    // Monday starts clear of Sunday's tail (9 > 6) — editing it to 03:00 would
    // not, since 03:00 falls inside the 00:00-06:00 tail.
    setTime('Monday start time', '03:00')

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Monday start time')).toHaveValue('03:00')
    expect(screen.getByText(/Overlaps Sunday's overnight shift here, 03:00–06:00/)).toBeInTheDocument()
  })
})

describe('WeeklyHoursEditor — the three shapes the backend rejects', () => {
  it('blocks an end of 00:00 and suggests 24:00', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} initial={[{ weekday: 0, start_hours: 9, end_hours: 17 }]} />)

    setTime('Monday end time', '00:00')

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(/cannot end at 00:00/i)).toHaveTextContent('24:00')
    // The rejected value stays on screen — snapping silently back would read as
    // a broken control rather than a rule.
    expect(screen.getByLabelText('Monday end time')).toHaveValue('00:00')
  })

  it('blocks a zero-length shift where start equals end', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} initial={[{ weekday: 0, start_hours: 9, end_hours: 17 }]} />)

    setTime('Monday start time', '17:00')

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(/cannot be the same time/i)).toBeInTheDocument()
  })

  it('blocks a round-the-clock 00:00 to 24:00 shift', () => {
    const onChange = vi.fn()
    // Starts already at 00:00 so the one edit under test is the end time --
    // a single commit attempt, cleanly asserting it never reaches onChange.
    render(<Harness onChange={onChange} initial={[{ weekday: 0, start_hours: 0, end_hours: 17 }]} />)

    setTime('Monday end time', '24:00')

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(/round-the-clock/i)).toBeInTheDocument()
  })

  it('accepts an ordinary shift ending exactly at midnight', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} initial={[{ weekday: 0, start_hours: 9, end_hours: 17 }]} />)

    setTime('Monday start time', '22:00')
    setTime('Monday end time', '24:00')

    expect(onChange).toHaveBeenCalledWith([{ weekday: 0, start_hours: 22, end_hours: 24 }])
  })

  it('recovers as soon as a valid time is chosen', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} initial={[{ weekday: 0, start_hours: 9, end_hours: 17 }]} />)

    setTime('Monday end time', '00:00')
    expect(onChange).not.toHaveBeenCalled()

    setTime('Monday end time', '23:45')

    expect(onChange).toHaveBeenCalledWith([{ weekday: 0, start_hours: 9, end_hours: 23.75 }])
    expect(screen.queryByText(/cannot end at 00:00/i)).toBeNull()
  })

  it('keeps the rejection on its own row', () => {
    render(
      <Harness
        initial={[
          { weekday: 0, start_hours: 9, end_hours: 17 },
          { weekday: 1, start_hours: 9, end_hours: 17 },
        ]}
      />,
    )

    setTime('Monday end time', '00:00')

    expect(screen.getAllByText(/cannot end at 00:00/i)).toHaveLength(1)
    expect(screen.getByRole('group', { name: 'Tuesday, 09:00 to 17:00, 8 hours' })).toBeInTheDocument()
  })
})

describe('WeeklyHoursEditor — disabled', () => {
  it('locks every day toggle', () => {
    render(<Harness disabled initial={[{ weekday: 0, start_hours: 9, end_hours: 17 }]} />)
    for (const toggle of screen.getAllByRole('switch')) expect(toggle).toBeDisabled()
    expect(screen.getByLabelText('Monday start time')).toBeDisabled()
  })
})

/**
 * The preset bar is asserted through its accessible names, not its layout: the
 * contract is "a button that says what it will do to which days at which time",
 * and the wire shape it produces. Both survive the bar being restyled.
 */
const WEEKDAYS_BUTTON = 'Set Monday to Friday, 09:00 to 18:00'
const WEEKENDS_BUTTON = 'Set Saturday and Sunday, 09:00 to 18:00'
const EVERY_DAY_BUTTON = 'Set Every day, 09:00 to 18:00'
const CLEAR_BUTTON = 'Clear all days'
const NIGHT_SHIFT_BUTTON = 'Use night shift, 22:00 to 06:00'
const BUSINESS_HOURS_BUTTON = 'Use business hours, 09:00 to 18:00'

const press = (user: ReturnType<typeof userEvent.setup>, name: string | RegExp) =>
  user.click(screen.getByRole('button', { name }))

const lastEmitted = (onChange: ReturnType<typeof vi.fn>): ShiftDTO[] =>
  onChange.mock.calls.at(-1)?.[0] as ShiftDTO[]

describe('WeeklyHoursEditor — day-set presets', () => {
  it('sets Monday to Friday and leaves the weekend off, in one click', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await press(user, WEEKDAYS_BUTTON)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(lastEmitted(onChange)).toEqual([
      { weekday: 0, start_hours: 9, end_hours: 18 },
      { weekday: 1, start_hours: 9, end_hours: 18 },
      { weekday: 2, start_hours: 9, end_hours: 18 },
      { weekday: 3, start_hours: 9, end_hours: 18 },
      { weekday: 4, start_hours: 9, end_hours: 18 },
    ])
    expect(screen.getByRole('group', { name: 'Saturday, not worked' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Sunday, not worked' })).toBeInTheDocument()
  })

  it('sets exactly the two weekend days', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await press(user, WEEKENDS_BUTTON)

    expect(lastEmitted(onChange)).toEqual([
      { weekday: 5, start_hours: 9, end_hours: 18 },
      { weekday: 6, start_hours: 9, end_hours: 18 },
    ])
  })

  it('sets all seven days', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await press(user, EVERY_DAY_BUTTON)

    expect(lastEmitted(onChange).map((shift) => shift.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('clears the week to an empty array', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Harness
        onChange={onChange}
        initial={[
          { weekday: 0, start_hours: 9, end_hours: 17 },
          { weekday: 3, start_hours: 22, end_hours: 6 },
        ]}
      />,
    )

    await press(user, CLEAR_BUTTON)

    expect(lastEmitted(onChange)).toEqual([])
    expect(screen.getByRole('group', { name: 'Monday, not worked' })).toBeInTheDocument()
  })

  it('replaces the day set rather than merging, so no weekday gains a second window', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Harness
        onChange={onChange}
        initial={[
          { weekday: 0, start_hours: 9, end_hours: 17 },
          { weekday: 5, start_hours: 10, end_hours: 14 },
        ]}
      />,
    )

    // A manual edit first — the preset must overwrite it, not stack on top.
    setTime('Monday start time', '08:00')
    await press(user, WEEKDAYS_BUTTON)

    const shifts = lastEmitted(onChange)
    expect(shifts).toHaveLength(5)
    expect(new Set(shifts.map((shift) => shift.weekday)).size).toBe(5)
    expect(shifts.map((shift) => shift.weekday)).toEqual([0, 1, 2, 3, 4])
    expect(shifts.every((shift) => shift.start_hours === 9 && shift.end_hours === 18)).toBe(true)
    // Saturday was outside the set, so it is off — not left at 10:00–14:00.
    expect(screen.getByRole('group', { name: 'Saturday, not worked' })).toBeInTheDocument()
  })
})

describe('WeeklyHoursEditor — the common time the presets apply', () => {
  it('applies a time chosen once to every day in the set', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    setTime('Common start time', '10:30')
    setTime('Common end time', '19:00')
    await press(user, /^Set Saturday and Sunday, 10:30 to 19:00$/)

    expect(lastEmitted(onChange)).toEqual([
      { weekday: 5, start_hours: 10.5, end_hours: 19 },
      { weekday: 6, start_hours: 10.5, end_hours: 19 },
    ])
  })

  it('turns the night shift into one overnight shift that continues onto the next day', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await press(user, NIGHT_SHIFT_BUTTON)
    await press(user, 'Set Monday to Friday, 22:00 to 06:00')

    const shifts = lastEmitted(onChange)
    expect(shifts).toHaveLength(5)
    expect(shifts.every((shift) => shift.start_hours === 22 && shift.end_hours === 6)).toBe(true)

    // Read back off the grid: one 8-hour shift, not two fragments.
    expect(screen.getByRole('group', { name: 'Monday, 22:00 to 06:00 the next day, 8 hours' })).toBeInTheDocument()
    // Saturday is off, yet Friday's shift still lands on it.
    expect(
      screen.getByRole('group', { name: "Saturday, not worked. Friday's shift continues until 06:00." }),
    ).toBeInTheDocument()
  })

  it('returns to business hours without touching the pickers', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await press(user, NIGHT_SHIFT_BUTTON)
    await press(user, BUSINESS_HOURS_BUTTON)
    await press(user, WEEKDAYS_BUTTON)

    expect(lastEmitted(onChange).every((shift) => shift.start_hours === 9 && shift.end_hours === 18)).toBe(true)
  })

  it('never emits an end of 00:00 or a zero-length shift, whichever preset is used', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    for (const shiftPreset of [BUSINESS_HOURS_BUTTON, NIGHT_SHIFT_BUTTON]) {
      await press(user, shiftPreset)
      for (const daySet of ['Monday to Friday', 'Saturday and Sunday', 'Every day']) {
        await press(user, new RegExp(`^Set ${daySet},`))
      }
    }
    await press(user, CLEAR_BUTTON)

    expect(onChange).toHaveBeenCalledTimes(7)
    for (const [emitted] of onChange.mock.calls as [ShiftDTO[]][]) {
      for (const shift of emitted) {
        expect(shift.end_hours).not.toBe(0)
        expect(shift.start_hours).not.toBe(shift.end_hours)
      }
    }
  })

  it('refuses to apply a common time the backend would reject', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    setTime('Common end time', '00:00')

    expect(screen.getByText(/cannot end at 00:00/i)).toHaveTextContent('24:00')
    for (const name of [/^Set Monday to Friday/, /^Set Saturday and Sunday/, /^Set Every day/]) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    // Clear needs no times, so it must stay usable.
    expect(screen.getByRole('button', { name: CLEAR_BUTTON })).toBeEnabled()
    expect(onChange).not.toHaveBeenCalled()

    setTime('Common end time', '23:45')
    await press(user, /^Set Saturday and Sunday, 09:00 to 23:45$/)

    expect(lastEmitted(onChange)).toEqual([
      { weekday: 5, start_hours: 9, end_hours: 23.75 },
      { weekday: 6, start_hours: 9, end_hours: 23.75 },
    ])
  })

  it('refuses a zero-length common time', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    setTime('Common end time', '09:00')

    expect(screen.getByText(/cannot be the same time/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Set Every day/ })).toBeDisabled()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('WeeklyHoursEditor — presets and the rest of the editor', () => {
  it('announces what a preset changed', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await press(user, WEEKDAYS_BUTTON)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Monday to Friday set to 09:00 to 18:00. All other days cleared.',
    )

    await press(user, CLEAR_BUTTON)
    expect(screen.getByRole('status')).toHaveTextContent('All days cleared. No hours set.')
  })

  it('names the midnight crossing when the applied time is overnight', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await press(user, NIGHT_SHIFT_BUTTON)
    await press(user, 'Set Every day, 22:00 to 06:00')

    expect(screen.getByRole('status')).toHaveTextContent('running past midnight into the next day')
  })

  it('drops a row-local rejected time when a preset overwrites that row', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ weekday: 0, start_hours: 9, end_hours: 17 }]} />)

    setTime('Monday end time', '00:00')
    expect(screen.getByText(/cannot end at 00:00/i)).toBeInTheDocument()

    await press(user, WEEKDAYS_BUTTON)

    expect(screen.queryByText(/cannot end at 00:00/i)).toBeNull()
    expect(screen.getByRole('group', { name: 'Monday, 09:00 to 18:00, 9 hours' })).toBeInTheDocument()
  })

  it('locks the whole preset bar when the editor is disabled', () => {
    render(<Harness disabled />)

    for (const name of [
      WEEKDAYS_BUTTON,
      WEEKENDS_BUTTON,
      EVERY_DAY_BUTTON,
      CLEAR_BUTTON,
      BUSINESS_HOURS_BUTTON,
      NIGHT_SHIFT_BUTTON,
    ]) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    expect(screen.getByLabelText('Common start time')).toBeDisabled()
    expect(screen.getByLabelText('Common end time')).toBeDisabled()
  })
})
