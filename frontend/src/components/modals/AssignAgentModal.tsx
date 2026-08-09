import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentConflictDTO, ScheduleConflictDTO } from '@/api/types'
import { Button, Input, Skeleton } from '@/components/ui'
import { ConflictBanner, EmptyState, ErrorState } from '@/components/feedback'
import {
  useAgents,
  useAssignmentConflicts,
  useRecheckAssignmentConflicts,
  useScheduleAssignees,
} from '@/hooks/queries'
import { useAssignAgent, useUnassignAgent } from '@/hooks/mutations'
import { useToast } from '@/context/ToastContext'
import { userMessage } from '@/helpers/errors'
import { hoursToHHMM } from '@/helpers/time'
import { weekdayShort } from '@/helpers/weekday'
import { cn } from '@/lib/cn'
import { Modal } from './Modal'

export interface AssignAgentModalProps {
  open: boolean
  onOpenChange: (o: boolean) => void
  scheduleId: number | null
}

/**
 * An agent the backend says cannot be assigned right now, with every schedule
 * that blocks them. The API's own shape, unchanged — reshaping it here would
 * mean a second definition of "conflict" to keep in step with the first.
 */
export type AssignmentConflict = AgentConflictDTO

/**
 * The one resolution this modal offers a control for: take the agent off the
 * schedule that blocks them, then let the re-check unlock the row.
 *
 * The other resolution — leave them out of the batch — needs no control, and
 * that is the whole design change here. Conflicts are answered *before* the
 * write by making the row unselectable, so "drop from batch" is the default
 * state of a conflicting row rather than a decision the user has to record.
 */
export type ConflictResolution = 'free-the-agent'

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * "Already on Day Shift · Mon 09:00–17:00".
 *
 * The hours named are `existing_*` — what the agent already works — because
 * those are the commitment the user has to go and change. Formatting goes
 * through `hoursToHHMM`/`weekdayShort` rather than being done by hand: the wire
 * format is a float and 9.5 is 09:30, not 09:50.
 */
function conflictReason(conflict: ScheduleConflictDTO): string {
  const when = conflict.colliding_shifts
    .map(
      (shift) =>
        `${weekdayShort(shift.weekday)} ${hoursToHHMM(shift.existing_start_hours)}–${hoursToHHMM(shift.existing_end_hours)}`,
    )
    .join(', ')
  return when === '' ? `Already on ${conflict.schedule_name}` : `Already on ${conflict.schedule_name} · ${when}`
}

/**
 * Picking coverage is a set operation — "these four people work this shift" —
 * so the picker is a checkbox group, not a radio group, and one confirm covers
 * the whole set.
 *
 * ── Conflicts are answered before the user can pick, not after they submit ──
 *
 * On open, the modal asks the backend which of the assignable agents it would
 * refuse (`useAssignmentConflicts`). Those rows render disabled, with the
 * reason beside them, so an agent who cannot be assigned is never a tick the
 * user has to take back. The overlap rule itself stays in the backend domain
 * layer — the client cannot see the other schedules an agent holds, and a
 * second copy of the rule would drift from the first.
 *
 * The list is held behind a skeleton until that first answer lands. A list that
 * is interactive for half a second and then disables three rows under the
 * user's cursor is worse than a list that arrives a moment later.
 *
 * The check is advisory: it writes nothing, and the other schedule can change
 * between the check and the write. So `assign` can still answer 409 and that
 * path is kept exactly as it was — the pre-check narrows the window, it does
 * not close it.
 *
 * ── The write ──
 *
 * The API assigns one agent at a time (`POST /schedules/{id}/agents`), so a set
 * of four is four requests. They run **sequentially**, not concurrently:
 *
 *  1. `useAssignAgent` is a single `useMutation` observer, and its per-call
 *     `onSuccess`/`onError` live on that observer rather than on the individual
 *     mutation. A second `mutate()` while the first is in flight replaces them
 *     and the first call's outcome is lost. One call in flight is the only
 *     shape where per-call callbacks are reliable, short of an observer per
 *     agent — real complexity to buy nothing below.
 *  2. It bounds the write burst without inventing a pool size. Server-side
 *     concurrency would be safe (each assignment takes a Postgres advisory lock
 *     keyed by agent id, and a batch is distinct agents by construction, so
 *     they never contend), but a batch is a handful of agents against a fast
 *     endpoint and an unbounded fan-out from every open modal buys milliseconds.
 *  3. Requests go out in list order, so anything reported afterwards reads in
 *     the same order as the list the user just ticked.
 *
 * A rejection *during* the write is now either a race or a genuine fault.
 * Either way the batch stops there rather than pressing on: the user's picture
 * of who is covered is already stale, and the honest thing is to say so and let
 * them look again.
 *
 * Already-assigned agents are filtered out rather than shown as disabled rows:
 * they are not a decision the user has to make, and hiding them keeps the list
 * short enough to scan. A *conflicting* agent is the opposite — it is exactly a
 * decision, so it stays on screen with a way out.
 */
export function AssignAgentModal({ open, onOpenChange, scheduleId }: AssignAgentModalProps) {
  const { toast } = useToast()
  const agents = useAgents()
  const assignees = useScheduleAssignees(open ? scheduleId : null)
  const assign = useAssignAgent()
  const unassign = useUnassignAgent()

  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  // Assignments this batch already landed. The assignees query is invalidated
  // on every success, but until it comes back the list would still offer people
  // who are on the schedule now — and re-picking them earns a 409.
  const [assignedNow, setAssignedNow] = useState<number[]>([])
  const [isAssigning, setIsAssigning] = useState(false)
  // Which (agent, other schedule) pair is being freed right now, so one row can
  // show progress without every other Free button spinning with it.
  const [freeing, setFreeing] = useState<{ agentId: number; scheduleId: number } | null>(null)

  const listRef = useRef<HTMLDivElement>(null)

  // Reopening for a different schedule must not inherit the previous answers —
  // a stale selection here would assign the wrong people in one click.
  useEffect(() => {
    if (open) {
      setSearch('')
      setSelectedIds([])
      setProblem(null)
      setAssignedNow([])
      setIsAssigning(false)
      setFreeing(null)
    }
  }, [open, scheduleId])

  /** Everyone who can still be picked, ignoring the search box. */
  const available = useMemo(() => {
    const taken = new Set([...(assignees.data ?? []).map((a) => a.id), ...assignedNow])
    return (agents.data ?? []).filter((agent) => !taken.has(agent.id))
  }, [agents.data, assignees.data, assignedNow])

  const directoryReady = !agents.isLoading && !assignees.isLoading && !agents.isError && !assignees.isError

  /**
   * The check is asked about *every* assignable agent, not just the ticked
   * ones — its answer is what decides whether a row can be ticked at all, so
   * asking per selection would be circular. Held at `[]` until the directory
   * has settled so the question is asked once, with the final set.
   */
  const checkIds = useMemo(
    () => (directoryReady ? available.map((agent) => agent.id) : []),
    [directoryReady, available],
  )
  const conflicts = useAssignmentConflicts(open ? scheduleId : null, checkIds)
  const recheck = useRecheckAssignmentConflicts(open ? scheduleId : null)

  const conflictByAgent = useMemo(
    () => new Map((conflicts.data ?? []).map((conflict) => [conflict.agent_id, conflict])),
    [conflicts.data],
  )

  /** What the list actually renders. Selection survives filtering: hiding a row
   *  is a view concern and must not silently drop someone from the batch. */
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') return available
    return available.filter(
      (agent) =>
        agent.name.toLowerCase().includes(needle) || (agent.email ?? '').toLowerCase().includes(needle),
    )
  }, [available, search])

  // `conflicts.isLoading` is the FIRST fetch only — `keepPreviousData` keeps
  // `isPending` false on every later one — so a re-check never throws the user
  // back to a skeleton, but the opening one does hold the list back.
  const isLoading = agents.isLoading || assignees.isLoading || conflicts.isLoading
  const failed = agents.isError || assignees.isError

  const selected = useMemo(() => new Set(selectedIds), [selectedIds])

  /** Rows the user is allowed to tick. Everything downstream — the count, the
   *  confirm label, select-all, the batch — is derived from this, never from
   *  `selectedIds` directly, so a conflict that appears after a tick cannot
   *  leak into the write. */
  const selectableFiltered = useMemo(
    () => filtered.filter((agent) => !conflictByAgent.has(agent.id)),
    [filtered, conflictByAgent],
  )
  const allFilteredSelected =
    selectableFiltered.length > 0 && selectableFiltered.every((agent) => selected.has(agent.id))
  const anyFilteredSelected = selectableFiltered.some((agent) => selected.has(agent.id))

  const count = useMemo(
    () => selectedIds.filter((id) => !conflictByAgent.has(id)).length,
    [selectedIds, conflictByAgent],
  )

  function toggle(agentId: number) {
    // The checkbox is already `disabled`, so this is unreachable by pointer or
    // keyboard. It is here because "cannot be selected" is a rule, and a rule
    // that lives only in a DOM attribute is one refactor from being gone.
    if (conflictByAgent.has(agentId)) return
    setSelectedIds((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId],
    )
  }

  function selectAllFiltered() {
    setSelectedIds((current) => [
      ...current,
      ...selectableFiltered.filter((agent) => !current.includes(agent.id)).map((agent) => agent.id),
    ])
  }

  function clearAllFiltered() {
    const inView = new Set(filtered.map((agent) => agent.id))
    setSelectedIds((current) => current.filter((id) => !inView.has(id)))
  }

  /* Native checkboxes are Tab-navigable but not arrow-navigable, and a long
     directory is far quicker to walk with the arrows. Tab still works.
     `:not(:disabled)` keeps conflicting rows out of the walk — they are not a
     selection target, and stopping on one would offer a tick that never lands.
     Their Free button is still a plain button on the Tab order. */
  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const boxes = Array.from(
      listRef.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not(:disabled)') ?? [],
    )
    const index = boxes.indexOf(document.activeElement as HTMLInputElement)
    if (index === -1) return
    event.preventDefault()
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1
    boxes[(next + boxes.length) % boxes.length]?.focus()
  }

  /**
   * Resolution #1: take the agent off the schedule that blocks them.
   *
   * The row is NOT unlocked here. The check is the only source of truth for who
   * conflicts — the agent may well be on a third schedule that also collides —
   * so the invalidation is the whole of the update and the row changes when the
   * backend answers again.
   */
  function handleFree(agentId: number, agentName: string, other: ScheduleConflictDTO) {
    if (freeing !== null || isAssigning) return
    setFreeing({ agentId, scheduleId: other.schedule_id })
    setProblem(null)
    unassign.mutate(
      { scheduleId: other.schedule_id, agentId },
      {
        onSuccess: () => {
          setFreeing(null)
          recheck()
        },
        onError: (error) => {
          setFreeing(null)
          setProblem(`${agentName} could not be taken off ${other.schedule_name}: ${userMessage(error)}`)
        },
      },
    )
  }

  /** Resolves rather than rejects, so the caller can stop the batch cleanly
   *  instead of unwinding through a throw. */
  function assignOne(id: number, agentId: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    return new Promise((resolve) => {
      assign.mutate(
        { scheduleId: id, agentId },
        {
          onSuccess: () => resolve({ ok: true }),
          onError: (error) => resolve({ ok: false, reason: userMessage(error) }),
        },
      )
    })
  }

  async function handleConfirm() {
    if (scheduleId === null || count === 0 || isAssigning) return

    // Snapshotted before the first request: the list re-derives as each success
    // invalidates the assignees query, and this must keep naming the people the
    // user actually picked. Conflicting agents are excluded again here — they
    // are already unselectable, and the write is the last place to find out.
    const batch = available.filter((agent) => selected.has(agent.id) && !conflictByAgent.has(agent.id))
    if (batch.length === 0) return

    setIsAssigning(true)
    setProblem(null)

    const assigned: typeof batch = []

    for (const agent of batch) {
      const outcome = await assignOne(scheduleId, agent.id)
      if (!outcome.ok) {
        // The pre-check said this was clear, so a rejection here is a race:
        // someone edited the other schedule in the last second. It stays an
        // inline message rather than a fault — it is an expected answer, just a
        // rarer one now.
        setIsAssigning(false)
        setAssignedNow((current) => [...current, ...assigned.map((a) => a.id)])
        // Whoever already landed is assigned — drop them from the selection so
        // a retry does not re-submit them, and say so, because implying a
        // rollback would send the user hunting for coverage that is already
        // there.
        setSelectedIds((current) => current.filter((id) => !assigned.some((a) => a.id === id)))
        setProblem(
          assigned.length === 0
            ? `${agent.name}: ${outcome.reason}`
            : `${agent.name}: ${outcome.reason} ${plural(assigned.length, 'agent')} assigned before this ` +
              `(${assigned.map((a) => a.name).join(', ')}) and nothing was undone.`,
        )
        return
      }
      assigned.push(agent)
    }

    setIsAssigning(false)
    setAssignedNow((current) => [...current, ...assigned.map((agent) => agent.id)])
    setSelectedIds([])
    toast({
      tone: 'success',
      message:
        assigned.length === 1
          ? `${assigned[0].name} assigned to this schedule.`
          : `${plural(assigned.length, 'agent')} assigned to this schedule.`,
    })
    onOpenChange(false)
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Assign agents"
      description="An agent can only be on one schedule at a time for any given hour."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={isAssigning}>
            Cancel
          </Button>
          <Button
            loading={isAssigning}
            disabled={count === 0 || scheduleId === null}
            onClick={() => void handleConfirm()}
          >
            {count === 0 ? 'Assign agents' : `Assign ${plural(count, 'agent')}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {problem && <ConflictBanner message={problem} onDismiss={() => setProblem(null)} />}

        <Input
          label="Find an agent"
          placeholder="Name or email"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          disabled={isLoading || failed || isAssigning}
        />

        {isLoading && (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Checking for overlapping schedules">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {!isLoading && failed && (
          <ErrorState
            error={agents.error ?? assignees.error}
            onRetry={() => {
              if (agents.isError) void agents.refetch()
              if (assignees.isError) void assignees.refetch()
            }}
          />
        )}

        {/* The check failing must not block the picker: it is advisory, and the
            409 on write is still there. Say the guard is down rather than
            pretending everyone is clear. */}
        {!isLoading && !failed && conflicts.isError && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-impact)]/30 bg-[var(--color-impact-bg)] px-3 py-2 text-[13px] text-[var(--color-impact)]"
          >
            <span className="flex-1">
              Could not check for overlapping schedules. Assignments may still be rejected.
            </span>
            <Button size="sm" variant="ghost" onClick={() => void conflicts.refetch()}>
              Try again
            </Button>
          </div>
        )}

        {!isLoading && !failed && filtered.length === 0 && (
          <EmptyState
            title={search.trim() ? 'No agents match that search' : 'Everyone is already assigned'}
            description={
              search.trim()
                ? 'Try a different name or email.'
                : 'Every agent in the directory is already on this schedule.'
            }
          />
        )}

        {!isLoading && !failed && filtered.length > 0 && (
          <>
            <div className="flex items-center justify-between gap-2">
              {/* Announced, not merely shown: the count is the only feedback for
                  a selection made entirely from the keyboard. */}
              <p aria-live="polite" className="text-[12px] text-[var(--color-ink-500)]">
                {count === 0 ? 'No agents selected' : `${plural(count, 'agent')} selected`}
              </p>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={selectAllFiltered}
                  disabled={isAssigning || selectableFiltered.length === 0 || allFilteredSelected}
                >
                  Select all
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={clearAllFiltered}
                  disabled={isAssigning || !anyFilteredSelected}
                >
                  Clear all
                </Button>
              </div>
            </div>

            <div
              ref={listRef}
              role="group"
              aria-label="Assignable agents"
              onKeyDown={handleListKeyDown}
              className="max-h-[280px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-hairline)]"
            >
              {filtered.map((agent) => {
                const conflict = conflictByAgent.get(agent.id)
                const isSelected = conflict === undefined && selected.has(agent.id)
                const inputId = `assign-agent-${agent.id}`
                const reasonId = (other: ScheduleConflictDTO) => `${inputId}-reason-${other.schedule_id}`

                return (
                  <div
                    key={agent.id}
                    data-selected={isSelected || undefined}
                    data-conflict={conflict !== undefined || undefined}
                    className={cn(
                      // items-start, not items-center: a conflict reason wraps
                      // to several lines, and centring would float the checkbox
                      // against the middle of the block.
                      'flex items-start gap-3 border-b border-[var(--color-hairline)] px-3 py-2.5 last:border-b-0',
                      // The tint is a hint, not the message: the row is also
                      // marked by a rule down its left edge, an icon, and the
                      // reason in words, so nothing here depends on seeing red.
                      conflict
                        ? 'border-l-2 border-l-[var(--color-conflict)] bg-[var(--color-conflict-bg)] pl-[10px]'
                        : isSelected
                          ? 'bg-[var(--color-brand-100)]'
                          : 'hover:bg-[var(--color-surface-sunken)]',
                    )}
                  >
                    {/* A native checkbox, so "selected" is in the accessibility
                        tree as a checked state rather than as a colour — and so
                        `disabled` genuinely removes it from the tab order
                        rather than just looking inert. */}
                    <input
                      id={inputId}
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-[var(--color-brand)] disabled:cursor-not-allowed"
                      checked={isSelected}
                      disabled={isAssigning || conflict !== undefined}
                      aria-disabled={conflict !== undefined || undefined}
                      aria-describedby={
                        conflict ? conflict.conflicts.map(reasonId).join(' ') || undefined : undefined
                      }
                      onChange={() => toggle(agent.id)}
                    />
                    {/* One column that owns the whole remaining width. The
                        conflict reason used to sit here as a shrink-0 SIBLING
                        of the name, so a long reason forced the row wider than
                        the modal: the name collapsed to nothing and the Free
                        button was pushed off-screen. Nesting it under the name
                        lets the reason wrap downwards instead of outwards. */}
                    <div className="min-w-0 flex-1">
                      <label
                        htmlFor={inputId}
                        className={cn('block', conflict ? 'cursor-not-allowed' : 'cursor-pointer')}
                      >
                        <span className="block truncate text-[14px] text-[var(--color-ink-900)]">{agent.name}</span>
                        {agent.email && (
                          <span className="block truncate text-[12px] text-[var(--color-ink-500)]">{agent.email}</span>
                        )}
                      </label>

                      {conflict && (
                        <div className="mt-1.5 flex flex-col gap-1.5">
                          {conflict.conflicts.map((other) => {
                            const isFreeing =
                              freeing?.agentId === agent.id && freeing.scheduleId === other.schedule_id

                            return (
                              <div key={other.schedule_id} className="flex items-start gap-2">
                                <svg
                                  className="mt-0.5 size-3.5 shrink-0 text-[var(--color-conflict)]"
                                  viewBox="0 0 16 16"
                                  fill="none"
                                  aria-hidden="true"
                                  focusable="false"
                                >
                                  <path d="M8 4.5v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                                  <circle cx="8" cy="11.25" r="0.9" fill="currentColor" />
                                  <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.3" />
                                </svg>
                                {/* Read out with the checkbox via
                                    `aria-describedby`, so the row announces both
                                    that it is unavailable and why.
                                    min-w-0 is what actually permits wrapping: a
                                    flex child defaults to min-width:auto and
                                    refuses to shrink below its content. */}
                                <span
                                  id={reasonId(other)}
                                  className="tabular min-w-0 flex-1 text-[12px] leading-snug break-words text-[var(--color-conflict)]"
                                >
                                  {conflictReason(other)}
                                </span>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  loading={isFreeing}
                                  disabled={isAssigning || (freeing !== null && !isFreeing)}
                                  aria-label={`Free ${agent.name} from ${other.schedule_name}`}
                                  onClick={() => handleFree(agent.id, agent.name, other)}
                                >
                                  Free
                                </Button>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
