import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/http'
import type { ReportDTO, ScheduleDTO } from '@/api/types'
import { toIsoDate } from '@/helpers/time'

import { AgentHoursTable } from './reports/AgentHoursTable'
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
    /** Lets a test assert the mutation was never reached, not just that a
        message appeared. */
    createMutate: vi.fn(),
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
    useGenerateReport: inert,
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
vi.mock('@/components/datetime', () => ({
  DateTimeField: () => null,
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
  h.createMutate.mockClear()
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
