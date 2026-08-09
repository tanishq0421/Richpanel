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

describe('WeeklyHoursEditor — the two shapes the backend rejects', () => {
  it('blocks an end of 00:00 and suggests 23:45', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} initial={[{ weekday: 0, start_hours: 9, end_hours: 17 }]} />)

    setTime('Monday end time', '00:00')

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(/cannot end at 00:00/i)).toHaveTextContent('23:45')
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
