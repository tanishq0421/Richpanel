import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mocked before any hook imports it, so every hook under test talks to this
// object instead of the network.
vi.mock('@/api/apiService', () => ({
  apiService: {
    agents: { list: vi.fn(), schedulesFor: vi.fn() },
    schedules: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      updateHours: vi.fn(),
      deletionImpact: vi.fn(),
      remove: vi.fn(),
    },
    assignments: { listAssignees: vi.fn(), check: vi.fn(), assign: vi.fn(), unassign: vi.fn() },
    reports: { generate: vi.fn(), list: vi.fn(), get: vi.fn() },
  },
}))

import { apiService } from '@/api/apiService'
import { ApiError } from '@/api/http'
import type { AgentDTO, ReportDTO, ScheduleDTO } from '@/api/types'
import { ToastProvider, useToast } from '@/context/ToastContext'
import { useAssignAgent } from '@/hooks/mutations/useAssignAgent'
import { useCreateSchedule } from '@/hooks/mutations/useCreateSchedule'
import { useDeleteSchedule } from '@/hooks/mutations/useDeleteSchedule'
import { useAgents } from '@/hooks/queries/useAgents'
import {
  useAssignmentConflicts,
  useRecheckAssignmentConflicts,
} from '@/hooks/queries/useAssignmentConflicts'
import { useDeletionImpact } from '@/hooks/queries/useDeletionImpact'
import { useSchedules } from '@/hooks/queries/useSchedules'
import { queryKeys } from '@/hooks/queryKeys'
import { useReportRows } from '@/hooks/useReportRows'

// ── Fixtures ────────────────────────────────────────────────────────────────

const AGENTS: AgentDTO[] = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.com' },
  { id: 2, name: 'Grace Hopper', email: null },
]

const SCHEDULE: ScheduleDTO = {
  id: 7,
  name: 'IST Morning',
  start_date: '2026-01-01',
  end_date: null,
  shifts: [{ weekday: 0, start_hours: 9, end_hours: 17.5 }],
}

const REPORT: ReportDTO = {
  id: 3,
  ticket_start_at: '2026-01-01T00:00:00+05:30',
  ticket_end_at: '2026-01-31T23:59:59+05:30',
  agent_hours: [
    { agent_id: 1, business_seconds: 3600 },
    { agent_id: 99, business_seconds: 1800 }, // agent deleted since the snapshot
  ],
}

// ── Harness ─────────────────────────────────────────────────────────────────

function makeClient() {
  return new QueryClient({
    // Retries would turn every failure assertion into a multi-second wait.
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Queries ─────────────────────────────────────────────────────────────────

describe('queries', () => {
  it('useAgents resolves the agent directory', async () => {
    vi.mocked(apiService.agents.list).mockResolvedValue(AGENTS)

    const { result } = renderHook(() => useAgents(), { wrapper: wrapperFor(makeClient()) })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(AGENTS)
    expect(apiService.agents.list).toHaveBeenCalledTimes(1)
  })

  it('surfaces an ApiError with its kind intact rather than a generic Error', async () => {
    vi.mocked(apiService.schedules.list).mockRejectedValue(
      new ApiError('conflict', 409, 'schedule_overlap', 'Overlaps an existing schedule'),
    )

    const { result } = renderHook(() => useSchedules(), { wrapper: wrapperFor(makeClient()) })

    await waitFor(() => expect(result.current.isError).toBe(true))
    const error = result.current.error
    expect(error).toBeInstanceOf(ApiError)
    expect(error?.kind).toBe('conflict')
    expect(error?.status).toBe(409)
    expect(error?.isRetryable).toBe(false)
  })

  it('useDeletionImpact does not fetch until an id is supplied', async () => {
    vi.mocked(apiService.schedules.deletionImpact).mockResolvedValue({
      schedule_id: 7,
      affected_agent_ids: [1, 2],
    })
    const wrapper = wrapperFor(makeClient())

    const { result, rerender } = renderHook(({ id }: { id: number | null }) => useDeletionImpact(id), {
      wrapper,
      initialProps: { id: null as number | null },
    })

    expect(result.current.fetchStatus).toBe('idle')
    expect(apiService.schedules.deletionImpact).not.toHaveBeenCalled()

    rerender({ id: 7 })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(apiService.schedules.deletionImpact).toHaveBeenCalledWith(7)
    expect(result.current.data?.affected_agent_ids).toEqual([1, 2])
  })
})

// ── Assignment conflict pre-check ───────────────────────────────────────────

const CONFLICTS = [
  {
    agent_id: 5,
    agent_name: 'Alice Chen',
    conflicts: [
      {
        schedule_id: 1,
        schedule_name: 'Day Shift',
        colliding_shifts: [
          {
            weekday: 0 as const,
            existing_start_hours: 9,
            existing_end_hours: 17,
            new_start_hours: 12,
            new_end_hours: 20,
          },
        ],
      },
    ],
  },
]

describe('useAssignmentConflicts', () => {
  it('asks nothing until the picker is open and the directory has loaded', async () => {
    vi.mocked(apiService.assignments.check).mockResolvedValue({ conflicts: CONFLICTS })
    const wrapper = wrapperFor(makeClient())

    const { result, rerender } = renderHook(
      ({ id, ids }: { id: number | null; ids: number[] }) => useAssignmentConflicts(id, ids),
      { wrapper, initialProps: { id: null as number | null, ids: [] as number[] } },
    )

    // Modal shut.
    expect(result.current.fetchStatus).toBe('idle')

    // Modal open, directory still in flight — there is no question to ask yet.
    rerender({ id: 7, ids: [] })
    expect(result.current.fetchStatus).toBe('idle')
    expect(apiService.assignments.check).not.toHaveBeenCalled()

    rerender({ id: 7, ids: [6, 5] })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // Sorted, so {6,5} and {5,6} are one cache entry rather than two identical
    // round-trips.
    expect(apiService.assignments.check).toHaveBeenCalledWith(7, [5, 6])
    // Unwrapped to the list — every caller wants the conflicts, not the envelope.
    expect(result.current.data).toEqual(CONFLICTS)
  })

  it('files both id orders under one cache entry', async () => {
    const client = makeClient()
    vi.mocked(apiService.assignments.check).mockResolvedValue({ conflicts: CONFLICTS })
    const wrapper = wrapperFor(client)

    const first = renderHook(() => useAssignmentConflicts(7, [5, 6]), { wrapper })
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true))

    // Reversed ids: the same question, so the answer is already there on the
    // first render rather than after a round-trip.
    const second = renderHook(() => useAssignmentConflicts(7, [6, 5]), { wrapper })
    expect(second.result.current.data).toEqual(CONFLICTS)

    expect(client.getQueryCache().findAll({ queryKey: queryKeys.schedules.assignmentChecks(7) })).toHaveLength(1)
  })

  it('useRecheckAssignmentConflicts falsifies every check held for the schedule', async () => {
    const client = makeClient()
    vi.mocked(apiService.assignments.check).mockResolvedValue({ conflicts: CONFLICTS })
    const wrapper = wrapperFor(client)

    const query = renderHook(() => useAssignmentConflicts(7, [5, 6]), { wrapper })
    await waitFor(() => expect(query.result.current.isSuccess).toBe(true))

    const { result } = renderHook(() => useRecheckAssignmentConflicts(7), { wrapper })
    act(() => result.current())

    // The set of ids the picker last asked about is not knowable from the
    // unassignment, so the prefix is invalidated rather than one exact key.
    await waitFor(() => expect(apiService.assignments.check).toHaveBeenCalledTimes(2))
    // A different schedule's answers are untouched — a broad ['schedules']
    // prefix would sweep them up.
    client.setQueryData(queryKeys.schedules.assignmentCheck(9, [5, 6]), [])
    act(() => result.current())
    expect(client.getQueryState(queryKeys.schedules.assignmentCheck(9, [5, 6]))?.isInvalidated).toBe(false)
  })

  it('does nothing when there is no schedule to re-check', () => {
    const client = makeClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    const { result } = renderHook(() => useRecheckAssignmentConflicts(null), { wrapper: wrapperFor(client) })
    act(() => result.current())

    expect(invalidate).not.toHaveBeenCalled()
  })
})

// ── useReportRows ───────────────────────────────────────────────────────────

describe('useReportRows', () => {
  it('joins agent names and falls back to "Agent #<id>" for a deleted agent', async () => {
    vi.mocked(apiService.agents.list).mockResolvedValue(AGENTS)

    const { result } = renderHook(() => useReportRows(REPORT), { wrapper: wrapperFor(makeClient()) })

    await waitFor(() => expect(result.current[0].agentName).toBe('Ada Lovelace'))
    expect(result.current).toEqual([
      { agentId: 1, agentName: 'Ada Lovelace', businessSeconds: 3600 },
      { agentId: 99, agentName: 'Agent #99', businessSeconds: 1800 },
    ])
  })

  it('returns an empty list for no report and stays referentially stable', async () => {
    vi.mocked(apiService.agents.list).mockResolvedValue(AGENTS)
    const wrapper = wrapperFor(makeClient())

    const empty = renderHook(() => useReportRows(undefined), { wrapper })
    expect(empty.result.current).toEqual([])

    const rows = renderHook(() => useReportRows(REPORT), { wrapper })
    await waitFor(() => expect(rows.result.current[0].agentName).toBe('Ada Lovelace'))

    const first = rows.result.current
    rows.rerender()
    expect(rows.result.current).toBe(first)
  })
})

// ── Mutation invalidation ───────────────────────────────────────────────────

describe('mutation invalidation', () => {
  it('useCreateSchedule invalidates the schedule list and the new schedule detail', async () => {
    const client = makeClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    vi.mocked(apiService.schedules.create).mockResolvedValue(SCHEDULE)

    const { result } = renderHook(() => useCreateSchedule(), { wrapper: wrapperFor(client) })
    result.current.mutate({ name: 'IST Morning', start_date: '2026-01-01', end_date: null, shifts: SCHEDULE.shifts })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.schedules.list() })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.schedules.detail(7) })
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('useDeleteSchedule invalidates the schedule list and that schedule detail', async () => {
    const client = makeClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    vi.mocked(apiService.schedules.remove).mockResolvedValue(undefined)

    const { result } = renderHook(() => useDeleteSchedule(), { wrapper: wrapperFor(client) })
    result.current.mutate(7)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.schedules.list() })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.schedules.detail(7) })
    // The cascade soft-deletes every assignment on this schedule, so the
    // assignee list is falsified too.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.schedules.assignees(7) })
  })

  it('useDeleteSchedule invalidates only the agents who were on that schedule', async () => {
    // Deleting a schedule cascades to N unassignments server-side, but the 204
    // response names none of them. The affected agents are identified from the
    // cache: any agent-schedule list mentioning this schedule is now stale.
    const client = makeClient()
    client.setQueryData(queryKeys.agents.schedules(1), [
      { id: 7, name: 'IST Morning' },
      { id: 9, name: 'IST Night' },
    ])
    client.setQueryData(queryKeys.agents.schedules(2), [{ id: 9, name: 'IST Night' }])
    vi.mocked(apiService.schedules.remove).mockResolvedValue(undefined)

    const { result } = renderHook(() => useDeleteSchedule(), { wrapper: wrapperFor(client) })
    result.current.mutate(7)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const state = (agentId: number) => client.getQueryState(queryKeys.agents.schedules(agentId))
    // Agent 1 was on schedule 7 → their list is stale and must refetch.
    expect(state(1)?.isInvalidated).toBe(true)
    // Agent 2 was never on it → untouched. This is the assertion that keeps the
    // invalidation SPECIFIC; a broad ['agents'] prefix would fail here.
    expect(state(2)?.isInvalidated).toBe(false)
  })

  it('useDeleteSchedule invalidates an agent-schedule query that has no cached data yet', async () => {
    // Cannot be ruled out, so it must not be silently left stale.
    const client = makeClient()
    client.setQueryData(queryKeys.agents.schedules(3), undefined)
    void client.getQueryCache().build(client, { queryKey: queryKeys.agents.schedules(3) })
    vi.mocked(apiService.schedules.remove).mockResolvedValue(undefined)

    const { result } = renderHook(() => useDeleteSchedule(), { wrapper: wrapperFor(client) })
    result.current.mutate(7)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(client.getQueryState(queryKeys.agents.schedules(3))?.isInvalidated).toBe(true)
  })

  it('useAssignAgent invalidates assignees and the agent schedules, but never reports', async () => {
    const client = makeClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    vi.mocked(apiService.assignments.assign).mockResolvedValue(undefined)

    const { result } = renderHook(() => useAssignAgent(), { wrapper: wrapperFor(client) })
    result.current.mutate({ scheduleId: 7, agentId: 2 })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.schedules.assignees(7) })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.agents.schedules(2) })

    // Reports are point-in-time snapshots — a coverage change today cannot
    // alter a past window's numbers.
    const invalidatedKeys = invalidate.mock.calls.map((call) => call[0]?.queryKey)
    expect(invalidatedKeys.some((key) => Array.isArray(key) && key[0] === 'reports')).toBe(false)
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('does not invalidate anything when the mutation fails', async () => {
    const client = makeClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    vi.mocked(apiService.assignments.assign).mockRejectedValue(
      new ApiError('conflict', 409, 'agent_overlap', 'Agent already covers these hours'),
    )

    const { result } = renderHook(() => useAssignAgent(), { wrapper: wrapperFor(client) })
    result.current.mutate({ scheduleId: 7, agentId: 2 })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.kind).toBe('conflict')
    expect(invalidate).not.toHaveBeenCalled()
  })
})

// ── Toasts ──────────────────────────────────────────────────────────────────

function ToastProbe() {
  const { toast } = useToast()
  return (
    <button type="button" onClick={() => toast({ tone: 'error', message: 'Could not assign agent' })}>
      fire
    </button>
  )
}

describe('ToastProvider', () => {
  it('announces a toast politely and dismisses it on click', () => {
    render(
      <ToastProvider>
        <ToastProbe />
      </ToastProvider>,
    )

    const live = screen.getByRole('status')
    expect(live).toHaveAttribute('aria-live', 'polite')

    fireEvent.click(screen.getByRole('button', { name: 'fire' }))
    expect(screen.getByText('Could not assign agent')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByText('Could not assign agent')).not.toBeInTheDocument()
  })

  it('auto-dismisses after five seconds', () => {
    vi.useFakeTimers()
    render(
      <ToastProvider>
        <ToastProbe />
      </ToastProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'fire' }))
    expect(screen.getByText('Could not assign agent')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(5_100)
    })
    expect(screen.queryByText('Could not assign agent')).not.toBeInTheDocument()
  })

  it('throws a useful error when used outside the provider', () => {
    expect(() => renderHook(() => useToast())).toThrow(/ToastProvider/)
  })
})
