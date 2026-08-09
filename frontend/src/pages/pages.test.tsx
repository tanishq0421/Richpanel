import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/http'
import type { ReportDTO, ScheduleDTO } from '@/api/types'
import { toIsoDate } from '@/helpers/time'

import { AgentHoursTable } from './reports/AgentHoursTable'
import { ReportForm } from './reports/ReportForm'
import { SchedulesPage } from './schedules/SchedulesPage'

/**
 * Page-level tests: the data layer is stubbed so these assert what the screens
 * *do* with a result — the shape of the loading, empty, error and 422 paths —
 * rather than re-testing the hooks, which have their own suite.
 *
 * The date/time controls are stubbed for the same reason: driving a calendar
 * popover to set one date says nothing about the form's error handling, and
 * `@/components/datetime` is covered by its own tests.
 */
const h = vi.hoisted(() => {
  const stub = (data: unknown) => ({ data, isLoading: false, error: null as unknown, refetch: () => {} })
  const now = new Date()
  return {
    /* Built from local date fields rather than an ISO string: the form's floor
       is `startOfToday()`, and a UTC round trip would land this on yesterday
       for the first 5h30m of every IST morning and fail the suite overnight. */
    today: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    past: new Date(2024, 2, 1),
    /* Day-of-month overflow normalises, so this stays a real local date. */
    later: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30),
    stamp: (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,
    clock: (d: Date) =>
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    /* The report suite pins the clock instead of reading it, so its days are
       fixed rather than derived from `now` — a report window is judged against
       the current minute, and a wall-clock-dependent fixture would pass or fail
       on the hour CI happened to run. 14:37 is off the 15-minute grid on
       purpose: the ceiling floors to 14:30. */
    reportNow: new Date(2025, 2, 10, 14, 37),
    reportToday: new Date(2025, 2, 10),
    reportYesterday: new Date(2025, 2, 9),
    reportTomorrow: new Date(2025, 2, 11),
    /** Lets a test assert the mutation was never reached, not just that a
        message appeared. */
    createMutate: vi.fn(),
    generateMutate: vi.fn(),
    state: {
      schedules: stub([]),
      schedule: stub(undefined),
      assignees: stub([]),
      agents: stub([]),
      reports: stub([]),
      report: stub(undefined),
      reportRows: [] as { agentId: number; agentName: string; businessSeconds: number }[],
      createError: null as unknown,
      created: { id: 7 } as unknown,
      generateError: null as unknown,
      generated: { id: 4 } as unknown,
    },
  }
})

vi.mock('@/hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSchedules: () => h.state.schedules,
  useSchedule: () => h.state.schedule,
  useScheduleAssignees: () => h.state.assignees,
  useAgents: () => h.state.agents,
  useReports: () => h.state.reports,
  useReport: () => h.state.report,
}))

vi.mock('@/hooks/useReportRows', () => ({
  useReportRows: () => h.state.reportRows,
}))

vi.mock('@/hooks/mutations', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const { useState } = await import('react')
  const inert = () => ({ mutate: () => {}, isPending: false, error: null, reset: () => {} })

  return {
    ...actual,
    // Stateful so a failed submit re-renders the form the way the real
    // mutation would, which is the whole point of the 422 test.
    useCreateSchedule: () => {
      const [error, setError] = useState<unknown>(null)
      return {
        error,
        isPending: false,
        reset: () => setError(null),
        mutate: (input: unknown, options?: { onSuccess?: (schedule: unknown) => void }) => {
          h.createMutate(input)
          if (h.state.createError) {
            setError(h.state.createError)
            return
          }
          options?.onSuccess?.(h.state.created)
        },
      }
    },
    useUpdateScheduleHours: inert,
    useUnassignAgent: inert,
    useAssignAgent: inert,
    useDeleteSchedule: inert,
    // Stateful for the same reason as create: a 422 has to re-render the form
    // still holding what the user chose, which is the point of the 422 tests.
    useGenerateReport: () => {
      const [error, setError] = useState<unknown>(null)
      return {
        error,
        isPending: false,
        reset: () => setError(null),
        mutate: (input: unknown, options?: { onSuccess?: (report: unknown) => void }) => {
          h.generateMutate(input)
          if (h.state.generateError) {
            setError(h.state.generateError)
            return
          }
          options?.onSuccess?.(h.state.generated)
        },
      }
    },
  }
})

/**
 * One stub serves both date fields, with every control namespaced by the
 * field's label. That is the point: the form now owns two independent dates,
 * so the double has to be able to drive one without touching the other — which
 * is exactly the regression these tests exist to catch.
 *
 * `value` and `minDate` are rendered as text so a test can assert what each
 * field actually holds and what floor it was handed, rather than inferring it.
 */
/**
 * Deliberately a *dumb* double: it neither bounds its options nor pulls a
 * stranded time back, so anything the report form is asserted to catch here it
 * catches on its own. The real bounding and clamping is the DateTimeField's,
 * and is covered in `components/datetime/datetime.test.tsx`.
 *
 * `max` is rendered as text so a test can assert the ceiling the form handed
 * down, and the error is prefixed with the field's label so a test can tell
 * *which* control a 422 landed on rather than merely that it appeared.
 */
vi.mock('@/components/datetime', () => ({
  DateTimeField: ({
    date,
    time,
    onChange,
    label,
    error,
    max,
  }: {
    date: Date | null
    time: string
    onChange: (v: { date: Date | null; time: string }) => void
    label?: string
    error?: string
    max?: Date
  }) => (
    <div>
      <span>{`${label} = ${date ? h.stamp(date) : 'empty'} ${time}`}</span>
      <span>{`${label} ceiling ${max ? `${h.stamp(max)} ${h.clock(max)}` : 'none'}`}</span>
      <button type="button" onClick={() => onChange({ date: h.reportToday, time })}>
        {`set ${label} today`}
      </button>
      <button type="button" onClick={() => onChange({ date: h.reportYesterday, time })}>
        {`set ${label} yesterday`}
      </button>
      {/* Stands in for state that went stale under an open tab — the real
          calendar no longer offers a day after today. */}
      <button type="button" onClick={() => onChange({ date: h.reportTomorrow, time })}>
        {`set ${label} tomorrow`}
      </button>
      {['08:00', '12:00', '23:45'].map((option) => (
        <button key={option} type="button" onClick={() => onChange({ date, time: option })}>
          {`set ${label} ${option}`}
        </button>
      ))}
      {error ? <span>{`${label} error: ${error}`}</span> : null}
    </div>
  ),
  DateRangePicker: () => null,
  DatePicker: ({
    value,
    onChange,
    label,
    error,
    minDate,
  }: {
    value: Date | null
    onChange: (d: Date | null) => void
    label?: string
    error?: string
    minDate?: Date
  }) => (
    <div>
      <span>{`${label} = ${value ? h.stamp(value) : 'empty'}`}</span>
      <span>{`${label} floor ${minDate ? h.stamp(minDate) : 'none'}`}</span>
      <button type="button" onClick={() => onChange(h.today)}>{`set ${label} today`}</button>
      {/* Stands in for a value that went stale after the calendar closed — the
          real picker no longer offers this day. */}
      <button type="button" onClick={() => onChange(h.past)}>{`set ${label} past`}</button>
      <button type="button" onClick={() => onChange(h.later)}>{`set ${label} later`}</button>
      <button type="button" onClick={() => onChange(null)}>{`clear ${label}`}</button>
      {error ? <span>{error}</span> : null}
    </div>
  ),
}))

vi.mock('@/components/datetime/WeeklyHoursEditor', () => ({
  WeeklyHoursEditor: ({ error }: { error?: string }) => <div>{error ? <span>{error}</span> : null}</div>,
}))

function renderPage(ui: ReactElement, path = '/schedules') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

const SCHEDULE: ScheduleDTO = {
  id: 1,
  name: 'India support — weekdays',
  start_date: '2024-03-01',
  end_date: null,
  shifts: [
    { weekday: 0, start_hours: 9, end_hours: 17.5 },
    { weekday: 1, start_hours: 9, end_hours: 17.5 },
  ],
}

const REPORT: ReportDTO = {
  id: 4,
  ticket_start_at: '2024-03-01T09:00:00+05:30',
  ticket_end_at: '2024-03-04T18:00:00+05:30',
  agent_hours: [],
}

beforeEach(() => {
  const stub = (data: unknown) => ({ data, isLoading: false, error: null as unknown, refetch: () => {} })
  h.state.schedules = stub([])
  h.state.schedule = stub(undefined)
  h.state.assignees = stub([])
  h.state.agents = stub([])
  h.state.reports = stub([])
  h.state.report = stub(undefined)
  h.state.reportRows = []
  h.state.createError = null
  h.state.created = { id: 7 }
  h.state.generateError = null
  h.state.generated = { id: 4 }
  h.createMutate.mockClear()
  h.generateMutate.mockClear()
})

describe('SchedulesPage', () => {
  it('lists each schedule with its effective dates', () => {
    h.state.schedules = {
      data: [SCHEDULE, { ...SCHEDULE, id: 2, name: 'Weekend cover', end_date: '2024-06-30' }],
      isLoading: false,
      error: null,
      refetch: () => {},
    }

    renderPage(<SchedulesPage />)

    expect(screen.getByText('India support — weekdays')).toBeInTheDocument()
    expect(screen.getByText('Weekend cover')).toBeInTheDocument()
    // Formatted off the ISO string, not through Date — see ScheduleList.
    expect(screen.getByText('1 Mar 2024 – ongoing')).toBeInTheDocument()
    expect(screen.getByText('1 Mar 2024 – 30 Jun 2024')).toBeInTheDocument()
  })

  it('shows an empty state when there are no schedules', () => {
    renderPage(<SchedulesPage />)

    expect(screen.getByText('No schedules yet')).toBeInTheDocument()
  })

  it('offers a retry when the schedule list fails to load', async () => {
    const user = userEvent.setup()
    const refetch = vi.fn()
    h.state.schedules = {
      data: undefined,
      isLoading: false,
      error: new ApiError('server', 500, 'internal_error', 'boom'),
      refetch,
    }

    renderPage(<SchedulesPage />)

    expect(screen.getByRole('alert')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /try again/i }))

    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('surfaces a 422 field error on create and keeps what was typed', async () => {
    const user = userEvent.setup()
    h.state.schedules = { data: [SCHEDULE], isLoading: false, error: null, refetch: () => {} }
    h.state.createError = new ApiError('validation', 422, 'validation_error', 'Some fields need attention.', [
      { field: 'name', message: 'A schedule with that name already exists.', type: 'value_error' },
    ])

    renderPage(<SchedulesPage />)

    await user.click(screen.getByRole('button', { name: 'New schedule' }))

    const name = screen.getByLabelText(/schedule name/i)
    await user.type(name, 'Night shift')
    await user.click(screen.getByRole('button', { name: 'set Starts today' }))
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))

    // The backend's per-field message lands on the control that caused it …
    expect(await screen.findByText('A schedule with that name already exists.')).toBeInTheDocument()
    expect(name).toHaveAttribute('aria-invalid', 'true')
    // … and the form still holds everything the user entered.
    expect(name).toHaveValue('Night shift')
    expect(screen.getByText(`Starts = ${h.stamp(h.today)}`)).toBeInTheDocument()
  })

  /**
   * The list has to be non-empty first: the empty state renders a "New
   * schedule" call to action of its own, and two of them make the query
   * ambiguous rather than wrong.
   */
  async function openCreateForm(user: ReturnType<typeof userEvent.setup>) {
    h.state.schedules = { data: [SCHEDULE], isLoading: false, error: null, refetch: () => {} }
    renderPage(<SchedulesPage />)
    await user.click(screen.getByRole('button', { name: 'New schedule' }))
  }

  it('floors the start at today, and the end at whatever start was chosen', async () => {
    const user = userEvent.setup()
    await openCreateForm(user)

    expect(screen.getByText(`Starts floor ${h.stamp(h.today)}`)).toBeInTheDocument()
    // Until a start exists the end can only be floored at today too.
    expect(screen.getByText(`Ends floor ${h.stamp(h.today)}`)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'set Starts later' }))

    // Picking a start moves the end's floor with it, so an end before the
    // start is never offered.
    expect(screen.getByText(`Ends floor ${h.stamp(h.later)}`)).toBeInTheDocument()
  })

  it('refuses a start date in the past and never reaches the mutation', async () => {
    const user = userEvent.setup()
    await openCreateForm(user)

    await user.type(screen.getByLabelText(/schedule name/i), 'Night shift')
    await user.click(screen.getByRole('button', { name: 'set Starts past' }))
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))

    expect(await screen.findByText("Schedules can't start in the past.")).toBeInTheDocument()
    expect(h.createMutate).not.toHaveBeenCalled()
  })

  it('lets a schedule starting today through', async () => {
    const user = userEvent.setup()
    await openCreateForm(user)

    await user.type(screen.getByLabelText(/schedule name/i), 'Night shift')
    await user.click(screen.getByRole('button', { name: 'set Starts today' }))
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))

    // The boundary is inclusive: today is not "the past".
    expect(screen.queryByText("Schedules can't start in the past.")).not.toBeInTheDocument()
    expect(h.createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ start_date: toIsoDate(h.today), end_date: null }),
    )
  })

  it('setting an end date leaves the start date alone', async () => {
    const user = userEvent.setup()
    await openCreateForm(user)

    await user.type(screen.getByLabelText(/schedule name/i), 'Night shift')
    await user.click(screen.getByRole('button', { name: 'set Starts today' }))
    await user.click(screen.getByRole('button', { name: 'set Ends later' }))

    // The whole point of the split: the second date cannot restart the first.
    expect(screen.getByText(`Starts = ${h.stamp(h.today)}`)).toBeInTheDocument()
    expect(screen.getByText(`Ends = ${h.stamp(h.later)}`)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create schedule' }))

    expect(h.createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        start_date: toIsoDate(h.today),
        end_date: toIsoDate(h.later),
      }),
    )
  })

  it('goes back to ongoing only when the end date is explicitly cleared', async () => {
    const user = userEvent.setup()
    await openCreateForm(user)

    await user.type(screen.getByLabelText(/schedule name/i), 'Night shift')
    await user.click(screen.getByRole('button', { name: 'set Starts today' }))
    await user.click(screen.getByRole('button', { name: 'set Ends later' }))
    await user.click(screen.getByRole('button', { name: 'clear Ends' }))

    expect(screen.getByText('Ends = empty')).toBeInTheDocument()
    // Clearing the end is not allowed to take the start with it.
    expect(screen.getByText(`Starts = ${h.stamp(h.today)}`)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create schedule' }))

    // `null` is a real value here — the schedule runs indefinitely.
    expect(h.createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ start_date: toIsoDate(h.today), end_date: null }),
    )
  })

  it('says so rather than dropping an end date stranded before a later start', async () => {
    const user = userEvent.setup()
    await openCreateForm(user)

    await user.type(screen.getByLabelText(/schedule name/i), 'Night shift')
    await user.click(screen.getByRole('button', { name: 'set Ends today' }))
    await user.click(screen.getByRole('button', { name: 'set Starts later' }))
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))

    expect(
      await screen.findByText('The end date cannot be before the start date.'),
    ).toBeInTheDocument()
    // Still there to be corrected, not silently discarded.
    expect(screen.getByText(`Ends = ${h.stamp(h.today)}`)).toBeInTheDocument()
    expect(h.createMutate).not.toHaveBeenCalled()
  })
})

/**
 * A report answers how many business hours each agent had *while a ticket was
 * open*, so the window may not reach past now — hours nobody has worked yet,
 * presented as history. The backend answers 422; these assert the form keeps
 * the user out of that state and says something useful when it cannot.
 *
 * The clock is pinned rather than read: the rule is judged against the current
 * minute, so a suite that used the real clock would pass or fail on the hour CI
 * happened to run. Only `Date` is faked — user-event drives its own timers, and
 * faking `setTimeout` here would hang every interaction.
 */
describe('ReportForm', () => {
  const FUTURE_MESSAGE = "A report can't cover time that hasn't happened yet."

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(h.reportNow)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** A window that closed hours ago: today 08:00 → today 12:00, both < 14:37. */
  async function fillValidWindow(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'set Ticket started today' }))
    await user.click(screen.getByRole('button', { name: 'set Ticket started 08:00' }))
    await user.click(screen.getByRole('button', { name: 'set Ticket resolved today' }))
    await user.click(screen.getByRole('button', { name: 'set Ticket resolved 12:00' }))
  }

  it('hands both fields now as their ceiling', () => {
    renderPage(<ReportForm onGenerated={vi.fn()} />, '/reports')

    const ceiling = `${h.stamp(h.reportNow)} ${h.clock(h.reportNow)}`
    expect(screen.getByText(`Ticket started ceiling ${ceiling}`)).toBeInTheDocument()
    expect(screen.getByText(`Ticket resolved ceiling ${ceiling}`)).toBeInTheDocument()
  })

  it('generates a report for a window that has already closed', async () => {
    const user = userEvent.setup()
    const onGenerated = vi.fn()
    renderPage(<ReportForm onGenerated={onGenerated} />, '/reports')

    await fillValidWindow(user)
    await user.click(screen.getByRole('button', { name: 'Generate report' }))

    expect(h.generateMutate).toHaveBeenCalledWith({
      ticketStartAt: '2025-03-10T08:00:00',
      ticketEndAt: '2025-03-10T12:00:00',
    })
    expect(onGenerated).toHaveBeenCalledWith({ id: 4 })
  })

  /**
   * The pickers cannot cover this on their own: "now" moves under a tab nobody
   * has touched, so a time chosen an hour ago can be in the future by the time
   * Generate is pressed.
   */
  it('blocks a window whose end has drifted into the future', async () => {
    const user = userEvent.setup()
    renderPage(<ReportForm onGenerated={vi.fn()} />, '/reports')

    await fillValidWindow(user)
    await user.click(screen.getByRole('button', { name: 'set Ticket resolved 23:45' }))
    await user.click(screen.getByRole('button', { name: 'Generate report' }))

    expect(await screen.findByText(`Ticket resolved error: ${FUTURE_MESSAGE}`)).toBeInTheDocument()
    expect(h.generateMutate).not.toHaveBeenCalled()
  })

  it('blocks a start date the calendar would no longer offer', async () => {
    const user = userEvent.setup()
    renderPage(<ReportForm onGenerated={vi.fn()} />, '/reports')

    await fillValidWindow(user)
    await user.click(screen.getByRole('button', { name: 'set Ticket started tomorrow' }))
    await user.click(screen.getByRole('button', { name: 'Generate report' }))

    expect(await screen.findByText(`Ticket started error: ${FUTURE_MESSAGE}`)).toBeInTheDocument()
    expect(h.generateMutate).not.toHaveBeenCalled()
  })

  /**
   * 23:45 was legal while the date was yesterday. Moving the date to today puts
   * it in the future — and whatever the field does about that, what must never
   * happen is the window going to the backend still saying 23:45.
   */
  it('does not submit a time the date change left in the future', async () => {
    const user = userEvent.setup()
    renderPage(<ReportForm onGenerated={vi.fn()} />, '/reports')

    await user.click(screen.getByRole('button', { name: 'set Ticket started yesterday' }))
    await user.click(screen.getByRole('button', { name: 'set Ticket started 08:00' }))
    await user.click(screen.getByRole('button', { name: 'set Ticket resolved yesterday' }))
    await user.click(screen.getByRole('button', { name: 'set Ticket resolved 23:45' }))
    // The date moves on; the time stays where it was.
    await user.click(screen.getByRole('button', { name: 'set Ticket resolved today' }))
    await user.click(screen.getByRole('button', { name: 'Generate report' }))

    expect(await screen.findByText(`Ticket resolved error: ${FUTURE_MESSAGE}`)).toBeInTheDocument()
    expect(h.generateMutate).not.toHaveBeenCalled()
  })

  it('still refuses a resolution that comes before the ticket started', async () => {
    const user = userEvent.setup()
    renderPage(<ReportForm onGenerated={vi.fn()} />, '/reports')

    await user.click(screen.getByRole('button', { name: 'set Ticket started today' }))
    await user.click(screen.getByRole('button', { name: 'set Ticket started 12:00' }))
    await user.click(screen.getByRole('button', { name: 'set Ticket resolved today' }))
    await user.click(screen.getByRole('button', { name: 'set Ticket resolved 08:00' }))
    await user.click(screen.getByRole('button', { name: 'Generate report' }))

    expect(
      await screen.findByText('Ticket resolved error: Resolution must come after the ticket start.'),
    ).toBeInTheDocument()
    expect(h.generateMutate).not.toHaveBeenCalled()
  })

  /**
   * The race is real: the guard passes, and the submit lands a second after the
   * window stopped being valid. Verified against the running API — the rule is
   * a pydantic *model* validator, so FastAPI's `loc` is `("body",)` and the
   * detail arrives addressed to "body", not to `ticket_end_at`. It still has to
   * reach the control it is about, in words a support manager can act on.
   */
  it('lands the backend 422 on the field it is about, keeping what was chosen', async () => {
    const user = userEvent.setup()
    h.state.generateError = new ApiError('validation', 422, 'validation_error', 'request validation failed', [
      {
        field: 'body',
        message:
          'Value error, a report window cannot extend into the future; ticket_end_at must not be later than the current time',
        type: 'value_error',
      },
    ])

    renderPage(<ReportForm onGenerated={vi.fn()} />, '/reports')
    await fillValidWindow(user)
    await user.click(screen.getByRole('button', { name: 'Generate report' }))

    expect(await screen.findByText(`Ticket resolved error: ${FUTURE_MESSAGE}`)).toBeInTheDocument()
    // The rule is about the end of the window, so the start is left alone …
    expect(screen.queryByText(/Ticket started error/)).not.toBeInTheDocument()
    // … and nothing the user chose is thrown away in the process.
    expect(screen.getByText(`Ticket started = ${h.stamp(h.reportToday)} 08:00`)).toBeInTheDocument()
    expect(screen.getByText(`Ticket resolved = ${h.stamp(h.reportToday)} 12:00`)).toBeInTheDocument()
  })

  it('surfaces a per-field 422 detail on the control that caused it', async () => {
    const user = userEvent.setup()
    h.state.generateError = new ApiError('validation', 422, 'validation_error', 'request validation failed', [
      { field: 'ticket_start_at', message: 'Input should be a valid datetime', type: 'datetime_parsing' },
    ])

    renderPage(<ReportForm onGenerated={vi.fn()} />, '/reports')
    await fillValidWindow(user)
    await user.click(screen.getByRole('button', { name: 'Generate report' }))

    expect(
      await screen.findByText('Ticket started error: Input should be a valid datetime'),
    ).toBeInTheDocument()
    expect(screen.getByText(`Ticket started = ${h.stamp(h.reportToday)} 08:00`)).toBeInTheDocument()
  })

  /** A rejection nothing can be pinned to must still be said out loud — a form
   *  that fails silently is worse than one that fails loudly. */
  it('falls back to a banner when a failure cannot be pinned to a field', async () => {
    const user = userEvent.setup()
    h.state.generateError = new ApiError('server', 500, 'internal_error', 'boom')

    renderPage(<ReportForm onGenerated={vi.fn()} />, '/reports')
    await fillValidWindow(user)
    await user.click(screen.getByRole('button', { name: 'Generate report' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server hit an unexpected problem. Nothing was saved.',
    )
  })
})

describe('AgentHoursTable', () => {
  it('renders every agent with formatted business hours, greying zero rather than reddening it', () => {
    h.state.reportRows = [
      { agentId: 1, agentName: 'Asha Menon', businessSeconds: 27000 },
      { agentId: 2, agentName: 'Rahul Iyer', businessSeconds: 0 },
      { agentId: 3, agentName: 'Priya Nair', businessSeconds: 3600 },
    ]

    renderPage(<AgentHoursTable report={REPORT} isLoading={false} error={null} onRetry={() => {}} />)

    expect(screen.getByText('Asha Menon')).toBeInTheDocument()
    expect(screen.getByText('7h 30m')).toBeInTheDocument()
    expect(screen.getByText('1h')).toBeInTheDocument()

    const zeroCell = screen.getByText('0h')
    expect(zeroCell).toHaveAttribute('data-zero', 'true')
    // Zero hours is a finding, not a failure.
    expect(zeroCell.className).toContain('var(--color-zero)')
    expect(zeroCell.className).not.toContain('conflict')

    // Three agents is far below the windowing threshold, so every row is in
    // the DOM rather than behind a virtualiser.
    expect(screen.getAllByRole('row')).toHaveLength(4)
  })

  it('windows the rows once the report covers more agents than fit on screen', () => {
    h.state.reportRows = Array.from({ length: 400 }, (_, index) => ({
      agentId: index + 1,
      agentName: `Agent ${index + 1}`,
      businessSeconds: 3600,
    }))

    renderPage(<AgentHoursTable report={REPORT} isLoading={false} error={null} onRetry={() => {}} />)

    expect(screen.getByRole('table').querySelector('[data-virtualized="true"]')).not.toBeNull()
    // 400 agents, nowhere near 400 rows in the DOM.
    expect(screen.getAllByRole('row').length).toBeLessThan(400)
  })

  it('shows an error with a retry instead of a blank table', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()

    renderPage(
      <AgentHoursTable
        report={undefined}
        isLoading={false}
        error={new ApiError('network', 0, 'network_error', 'Could not reach the server.')}
        onRetry={onRetry}
      />,
    )

    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('explains that no report is open rather than rendering an empty grid', () => {
    renderPage(<AgentHoursTable report={undefined} isLoading={false} error={null} onRetry={() => {}} />)

    expect(screen.getByText('No report open')).toBeInTheDocument()
  })
})
