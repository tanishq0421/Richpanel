import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { startOfToday } from 'date-fns'
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

  /**
   * A schedule may not take effect in the past, which is expressed as
   * `minDate={startOfToday()}`. The clock is pinned so that "today" is a
   * specific, assertable cell and so the day aria-labels stay stable.
   *
   * Only `Date` is faked: user-event drives its own timers, and replacing
   * `setTimeout` here would hang every interaction below.
   */
  describe('with a minDate', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2025, 2, 10, 9, 30))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    async function openCalendar(onChange: (r: { from: Date | null; to: Date | null }) => void) {
      const user = userEvent.setup()
      render(
        <DateRangePicker
          from={null}
          to={null}
          onChange={onChange}
          label="Active window"
          minDate={startOfToday()}
        />,
      )
      await user.click(screen.getByRole('button', { name: /active window/i }))
      await screen.findByRole('dialog')
      return user
    }

    it('makes an earlier day unselectable, not merely rejected after the click', async () => {
      const onChange = vi.fn()
      const user = await openCalendar(onChange)

      const yesterday = screen.getByRole('button', { name: /March 9th, 2025/ })
      expect(yesterday).toBeDisabled()

      await user.click(yesterday)

      expect(onChange).not.toHaveBeenCalled()
    })

    it('leaves the boundary day itself selectable — today is allowed', async () => {
      const onChange = vi.fn()
      const user = await openCalendar(onChange)

      const today = screen.getByRole('button', { name: /March 10th, 2025/ })
      expect(today).toBeEnabled()

      await user.click(today)

      expect(onChange).toHaveBeenCalledTimes(1)
      // Local fields, never UTC — the wall-clock day has to survive the trip.
      const picked = onChange.mock.calls[0][0].from as Date
      expect([picked.getFullYear(), picked.getMonth(), picked.getDate()]).toEqual([2025, 2, 10])
    })

    it('cannot be talked into a past day by keyboard either', async () => {
      const onChange = vi.fn()
      const user = await openCalendar(onChange)

      const today = screen.getByRole('button', { name: /March 10th, 2025/ })
      await waitFor(() => expect(today).toHaveFocus())

      // One step left is the disabled 9 March, so the roving tabindex has
      // nowhere to go — greying the day is not the whole of it, the day is
      // genuinely out of reach.
      await user.keyboard('{ArrowLeft}')
      expect(today).toHaveFocus()

      await user.keyboard('{Enter}')
      const picked = onChange.mock.calls[0][0].from as Date
      expect([picked.getFullYear(), picked.getMonth(), picked.getDate()]).toEqual([2025, 2, 10])
    })
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

  /**
   * `maxTime` is how a report window is stopped from reaching into the future
   * once the chosen day is today. The bound is deliberately off-grid — 14:37 is
   * a real clock reading, and it has to round *down* to 14:30 rather than up.
   */
  describe('with a maxTime', () => {
    async function openBounded(onChange = vi.fn()) {
      const user = userEvent.setup()
      render(<TimePicker value="09:00" onChange={onChange} label="Shift start" maxTime="14:30" />)
      await user.click(screen.getByRole('button', { name: /shift start/i }))
      const listbox = await screen.findByRole('listbox')
      return { user, listbox, onChange }
    }

    it('marks later options unavailable and leaves earlier ones choosable', async () => {
      const { listbox } = await openBounded()

      expect(within(listbox).getByRole('option', { name: '14:30' })).not.toHaveAttribute('aria-disabled')
      expect(within(listbox).getByRole('option', { name: '09:00' })).not.toHaveAttribute('aria-disabled')
      expect(within(listbox).getByRole('option', { name: '14:45' })).toHaveAttribute('aria-disabled', 'true')
      expect(within(listbox).getByRole('option', { name: '23:45' })).toHaveAttribute('aria-disabled', 'true')
    })

    it('explains the bound rather than leaving a struck-through row unaccounted for', async () => {
      const { listbox } = await openBounded()

      expect(listbox).toHaveAccessibleDescription('Later than 14:30 hasn’t happened yet.')
    })

    it('refuses to commit an out-of-range option that is clicked anyway', async () => {
      const { user, listbox, onChange } = await openBounded()

      await user.click(within(listbox).getByRole('option', { name: '14:45' }))
      expect(onChange).not.toHaveBeenCalled()

      await user.click(within(listbox).getByRole('option', { name: '14:30' }))
      expect(onChange).toHaveBeenCalledWith('14:30')
    })

    it('cannot be walked past the bound with the keyboard either', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      render(<TimePicker value="14:15" onChange={onChange} label="Shift start" maxTime="14:30" />)

      await user.click(screen.getByRole('button', { name: /shift start/i }))
      const listbox = await screen.findByRole('listbox')
      await waitFor(() => expect(listbox).toHaveFocus())

      // One step lands on the bound; three more have nowhere to go.
      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}')
      expect(onChange).toHaveBeenCalledWith('14:30')
    })

    it('sends End to the bound, not to the end of the day', async () => {
      const { user, onChange } = await openBounded()

      await user.keyboard('{End}{Enter}')
      expect(onChange).toHaveBeenCalledWith('14:30')
    })

    it('ignores a typeahead that would land out of range', async () => {
      const { user, listbox, onChange } = await openBounded()
      const before = listbox.getAttribute('aria-activedescendant')

      await user.keyboard('22')

      expect(listbox).toHaveAttribute('aria-activedescendant', before)
      await user.keyboard('{Enter}')
      expect(onChange).toHaveBeenCalledWith('09:00')
    })

    it('offers the whole day when there is no bound', async () => {
      const user = userEvent.setup()
      render(<TimePicker value="09:00" onChange={vi.fn()} label="Shift start" />)

      await user.click(screen.getByRole('button', { name: /shift start/i }))
      const listbox = await screen.findByRole('listbox')

      const unavailable = within(listbox)
        .getAllByRole('option')
        .filter((option) => option.getAttribute('aria-disabled') === 'true')
      expect(unavailable).toHaveLength(0)
    })
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

  /**
   * A report window may not reach past now, which is expressed as `max={new
   * Date()}`. The clock is pinned so "now" is a specific assertable minute and
   * the day aria-labels stay stable — the suite must not care what time CI runs.
   *
   * 14:37 is deliberately off the 15-minute grid: the ceiling has to floor to
   * 14:30, never round up to 14:45.
   *
   * Only `Date` is faked, the same as the DateRangePicker block above:
   * user-event drives its own timers and faking `setTimeout` would hang every
   * interaction here.
   */
  describe('with a max moment', () => {
    const NOW = new Date(2025, 2, 10, 14, 37)
    const YESTERDAY = new Date(2025, 2, 9)

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    async function openTimes(date: Date, time = '09:00', onChange = vi.fn()) {
      const user = userEvent.setup()
      render(
        <DateTimeField date={date} time={time} onChange={onChange} label="Ticket resolved" max={new Date()} />,
      )
      await user.click(screen.getByRole('button', { name: /ticket resolved time/i }))
      const listbox = await screen.findByRole('listbox')
      return { user, listbox, onChange }
    }

    it('makes a future day unselectable, not merely rejected after the click', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      render(
        <DateTimeField date={MARCH_10} time="09:00" onChange={onChange} label="Ticket resolved" max={new Date()} />,
      )

      await user.click(screen.getByRole('button', { name: /10 Mar 2025/ }))
      await screen.findByRole('dialog')

      const tomorrow = screen.getByRole('button', { name: /March 11th, 2025/ })
      expect(tomorrow).toBeDisabled()
      await user.click(tomorrow)
      expect(onChange).not.toHaveBeenCalled()

      // Today itself is the boundary and stays available.
      expect(screen.getByRole('button', { name: /March 10th, 2025/ })).toBeEnabled()
    })

    it('cannot be talked into a future day by keyboard either', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      render(
        <DateTimeField date={MARCH_10} time="09:00" onChange={onChange} label="Ticket resolved" max={new Date()} />,
      )

      await user.click(screen.getByRole('button', { name: /10 Mar 2025/ }))
      await screen.findByRole('dialog')

      const today = screen.getByRole('button', { name: /March 10th, 2025/ })
      await waitFor(() => expect(today).toHaveFocus())

      // One step right is the disabled 11 March, so the roving tabindex has
      // nowhere to go — the day is genuinely out of reach, not merely greyed.
      await user.keyboard('{ArrowRight}')
      expect(today).toHaveFocus()
    })

    it('stops the times at now when the chosen day is today', async () => {
      const { listbox } = await openTimes(MARCH_10)

      expect(within(listbox).getByRole('option', { name: '14:30' })).not.toHaveAttribute('aria-disabled')
      expect(within(listbox).getByRole('option', { name: '09:00' })).not.toHaveAttribute('aria-disabled')
      // 14:37 floors onto the grid: 14:45 is still in the future.
      expect(within(listbox).getByRole('option', { name: '14:45' })).toHaveAttribute('aria-disabled', 'true')
      expect(within(listbox).getByRole('option', { name: '18:00' })).toHaveAttribute('aria-disabled', 'true')
    })

    it('offers the whole day once the chosen day is an earlier one', async () => {
      const { listbox } = await openTimes(YESTERDAY)

      const unavailable = within(listbox)
        .getAllByRole('option')
        .filter((option) => option.getAttribute('aria-disabled') === 'true')
      expect(unavailable).toHaveLength(0)
      expect(within(listbox).getByRole('option', { name: '23:45' })).not.toHaveAttribute('aria-disabled')
    })

    /**
     * The case the pickers alone cannot cover: 18:00 was a perfectly legal time
     * on yesterday, and moving the date to today puts it in the future. It is
     * pulled back to the last legal step and the move is stated — what must not
     * happen is the field quietly continuing to hold 18:00.
     */
    it('pulls a now-future time back when the date moves onto today, and says so', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      render(
        <DateTimeField date={YESTERDAY} time="18:00" onChange={onChange} label="Ticket resolved" max={new Date()} />,
      )

      await user.click(screen.getByRole('button', { name: /9 Mar 2025/ }))
      await screen.findByRole('dialog')
      await user.click(screen.getByRole('button', { name: /March 10th, 2025/ }))

      expect(onChange).toHaveBeenCalledWith({ date: new Date(2025, 2, 10), time: '14:30' })
      expect(await screen.findByRole('status')).toHaveTextContent(
        'Time moved back to 14:30 — later times on this date haven’t happened yet.',
      )
    })

    it('leaves a time that is still in the past alone', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      render(
        <DateTimeField date={YESTERDAY} time="09:00" onChange={onChange} label="Ticket resolved" max={new Date()} />,
      )

      await user.click(screen.getByRole('button', { name: /9 Mar 2025/ }))
      await screen.findByRole('dialog')
      await user.click(screen.getByRole('button', { name: /March 10th, 2025/ }))

      expect(onChange).toHaveBeenCalledWith({ date: new Date(2025, 2, 10), time: '09:00' })
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
  })
})
