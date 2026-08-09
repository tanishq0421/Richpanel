import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { timeOptions } from '@/helpers/time'
import { DatePicker } from './DatePicker'
import { DateRangePicker } from './DateRangePicker'
import { TimePicker } from './TimePicker'
import { DateTimeField } from './DateTimeField'

/* Radix positions its popover with floating-ui, and the time listbox scrolls
   the active row into view. jsdom has neither API, so they are stubbed here
   rather than in the shared setup file — nothing else in the suite needs them. */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

/** A fixed, non-today month so the day aria-labels are stable across runs. */
const MARCH_10 = new Date(2025, 2, 10)

describe('DatePicker', () => {
  it('opens the calendar and reports the day the user picks, in local time', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<DatePicker value={MARCH_10} onChange={onChange} label="Start date" />)

    await user.click(screen.getByRole('button', { name: /start date/i }))
    await screen.findByRole('dialog')

    await user.click(screen.getByRole('button', { name: /March 15th, 2025/ }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const picked = onChange.mock.calls[0][0] as Date
    expect(picked).toEqual(new Date(2025, 2, 15))
    // Local fields, never UTC: the wall-clock day must survive the round trip.
    expect([picked.getFullYear(), picked.getMonth(), picked.getDate()]).toEqual([2025, 2, 15])
    expect(picked.getHours()).toBe(0)
  })

  it('names the trigger with both its label and its current value', () => {
    render(<DatePicker value={MARCH_10} onChange={vi.fn()} label="Start date" />)
    expect(screen.getByRole('button', { name: 'Start date 10 Mar 2025' })).toBeInTheDocument()
  })

  it('disables days outside minDate / maxDate', async () => {
    const user = userEvent.setup()
    render(
      <DatePicker
        value={new Date(2025, 2, 12)}
        onChange={vi.fn()}
        label="Start date"
        minDate={new Date(2025, 2, 10)}
        maxDate={new Date(2025, 2, 20)}
      />,
    )

    await user.click(screen.getByRole('button', { name: /start date/i }))
    await screen.findByRole('dialog')

    expect(screen.getByRole('button', { name: /March 9th, 2025/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /March 21st, 2025/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /March 15th, 2025/ })).toBeEnabled()
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<DatePicker value={MARCH_10} onChange={vi.fn()} label="Start date" />)

    const trigger = screen.getByRole('button', { name: /start date/i })
    await user.click(trigger)
    await screen.findByRole('dialog')

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('is reachable and operable by keyboard alone', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<DatePicker value={MARCH_10} onChange={onChange} label="Start date" />)

    await user.tab()
    expect(screen.getByRole('button', { name: /start date/i })).toHaveFocus()

    await user.keyboard('{Enter}')
    await screen.findByRole('dialog')
    // Focus lands on the selected day, so one ArrowRight is 11 March.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /March 10th, 2025/ })).toHaveFocus(),
    )

    await user.keyboard('{ArrowRight}{Enter}')
    expect(onChange).toHaveBeenCalledWith(new Date(2025, 2, 11))
  })
})

describe('DateRangePicker', () => {
  it('reads an open-ended range as ongoing rather than half-finished', () => {
    render(<DateRangePicker from={MARCH_10} to={null} onChange={vi.fn()} label="Active window" />)

    const trigger = screen.getByRole('button', { name: /active window/i })
    expect(trigger).toHaveTextContent('10 Mar 2025 – ongoing')
    expect(trigger).toHaveAccessibleName(/ongoing/i)
  })

  it('reports both ends once the second day is picked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<DateRangePicker from={MARCH_10} to={null} onChange={onChange} label="Active window" />)

    await user.click(screen.getByRole('button', { name: /active window/i }))
    await screen.findByRole('dialog')

    await user.click(screen.getByRole('button', { name: /March 20th, 2025/ }))

    expect(onChange).toHaveBeenCalledWith({
      from: new Date(2025, 2, 10),
      to: new Date(2025, 2, 20),
    })
  })

  it('can drop the end date again without clearing the start', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <DateRangePicker
        from={MARCH_10}
        to={new Date(2025, 2, 20)}
        onChange={onChange}
        label="Active window"
      />,
    )

    await user.click(screen.getByRole('button', { name: /active window/i }))
    await screen.findByRole('dialog')

    await user.click(screen.getByRole('button', { name: 'No end date' }))

    expect(onChange).toHaveBeenCalledWith({ from: MARCH_10, to: null })
  })
})

describe('TimePicker', () => {
  it('emits a valid HH:MM drawn from timeOptions()', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TimePicker value="09:00" onChange={onChange} label="Shift start" />)

    await user.click(screen.getByRole('button', { name: /shift start/i }))
    const listbox = await screen.findByRole('listbox')

    await user.click(within(listbox).getByRole('option', { name: '22:30' }))

    expect(onChange).toHaveBeenCalledWith('22:30')
    expect(timeOptions()).toContain(onChange.mock.calls[0][0])
  })

  it('offers only quarter-hour options', async () => {
    const user = userEvent.setup()
    render(<TimePicker value="09:00" onChange={vi.fn()} label="Shift start" />)

    await user.click(screen.getByRole('button', { name: /shift start/i }))
    const listbox = await screen.findByRole('listbox')

    const labels = within(listbox)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(labels).toEqual(timeOptions())
  })

  it('is operable by keyboard alone: arrow to move, Enter to select', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TimePicker value="09:00" onChange={onChange} label="Shift start" />)

    await user.tab()
    expect(screen.getByRole('button', { name: /shift start/i })).toHaveFocus()

    await user.keyboard('{Enter}')
    const listbox = await screen.findByRole('listbox')
    await waitFor(() => expect(listbox).toHaveFocus())

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')

    expect(onChange).toHaveBeenCalledWith('09:30')
    expect(timeOptions()).toContain(onChange.mock.calls[0][0])
  })

  it('jumps to 22:00 when the user types "22"', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TimePicker value="09:00" onChange={onChange} label="Shift start" />)

    await user.click(screen.getByRole('button', { name: /shift start/i }))
    const listbox = await screen.findByRole('listbox')
    await waitFor(() => expect(listbox).toHaveFocus())

    await user.keyboard('22')
    await waitFor(() =>
      expect(listbox).toHaveAttribute(
        'aria-activedescendant',
        within(listbox).getByRole('option', { name: '22:00' }).id,
      ),
    )

    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('22:00')
  })

  it('reaches a single-digit hour by typing "9"', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TimePicker value="00:00" onChange={onChange} label="Shift start" />)

    await user.click(screen.getByRole('button', { name: /shift start/i }))
    const listbox = await screen.findByRole('listbox')
    await waitFor(() => expect(listbox).toHaveFocus())

    await user.keyboard('9{Enter}')
    expect(onChange).toHaveBeenCalledWith('09:00')
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TimePicker value="09:00" onChange={onChange} label="Shift start" />)

    const trigger = screen.getByRole('button', { name: /shift start/i })
    await user.click(trigger)
    await screen.findByRole('listbox')

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('cannot be opened when disabled', async () => {
    const user = userEvent.setup()
    render(<TimePicker value="09:00" onChange={vi.fn()} label="Shift start" disabled />)

    const trigger = screen.getByRole('button', { name: /shift start/i })
    expect(trigger).toBeDisabled()
    await user.click(trigger)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})

describe('DateTimeField', () => {
  it('keeps the time when only the date changes', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <DateTimeField date={MARCH_10} time="09:00" onChange={onChange} label="Effective from" />,
    )

    await user.click(screen.getByRole('button', { name: /10 Mar 2025/ }))
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: /March 18th, 2025/ }))

    expect(onChange).toHaveBeenCalledWith({ date: new Date(2025, 2, 18), time: '09:00' })
  })

  it('keeps the date when only the time changes', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <DateTimeField date={MARCH_10} time="09:00" onChange={onChange} label="Effective from" />,
    )

    await user.click(screen.getByRole('button', { name: /effective from time/i }))
    const listbox = await screen.findByRole('listbox')
    await user.click(within(listbox).getByRole('option', { name: '17:45' }))

    expect(onChange).toHaveBeenCalledWith({ date: MARCH_10, time: '17:45' })
  })

  it('groups both controls under one label and one message', () => {
    render(
      <DateTimeField
        date={MARCH_10}
        time="09:00"
        onChange={vi.fn()}
        label="Effective from"
        error="Pick a date in the future"
      />,
    )

    const group = screen.getByRole('group', { name: 'Effective from' })
    expect(group).toHaveAccessibleDescription('Pick a date in the future')
    expect(within(group).getAllByRole('button')).toHaveLength(2)
  })
})
