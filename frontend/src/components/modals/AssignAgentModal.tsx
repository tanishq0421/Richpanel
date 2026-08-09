import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ShiftDTO } from '@/api/types'
import { Button, Input, Skeleton } from '@/components/ui'
import { ConflictBanner, EmptyState, ErrorState } from '@/components/feedback'
import { useAgents, useScheduleAssignees } from '@/hooks/queries'
import { useAssignAgent } from '@/hooks/mutations'
import { useToast } from '@/context/ToastContext'
import { userMessage } from '@/helpers/errors'
import { cn } from '@/lib/cn'
import { Modal } from './Modal'

export interface AssignAgentModalProps {
  open: boolean
  onOpenChange: (o: boolean) => void
  scheduleId: number | null
}

/* ══════════════════════════════════════════════════════════════════════════
   SEAM — conflict pre-check. NOT IMPLEMENTED; the API contract is unsettled.

   The product rule is that conflicts are found and resolved *before* anything
   is written: confirm must not assign three agents and then explain that two
   were rejected. So `findAssignmentConflicts` runs first, and the write only
   starts once it comes back clean.

   The overlap rule itself stays in the backend domain layer. It is not
   reimplemented here — a second copy in the UI would drift from the first, and
   the UI copy cannot see the other schedules an agent holds anyway.

   What this seam needs from the API, for a given schedule id + the selected
   agent ids, one entry per agent that would be rejected:

     - `agentId` / `agentName`     — who conflicts (name so the UI never has to
                                     re-join against the directory)
     - `conflictingScheduleId`     — the *other* schedule, addressable, because
                                     resolution #1 unassigns the agent from it
     - `conflictingScheduleName`   — how the user recognises that schedule
     - `collidingShifts`           — the hours that actually collide (weekday +
                                     start_hours/end_hours as floats, IST, same
                                     shape as `ShiftDTO`), so the UI can say
                                     *when* rather than just *that*

   Once it is wired, each conflict gets two resolutions (`ConflictResolution`):
   unassign the agent from `conflictingScheduleId`, or drop them from this
   batch. The assignment proceeds only when every conflict has one.
   ══════════════════════════════════════════════════════════════════════════ */

export interface AssignmentConflict {
  agentId: number
  agentName: string
  conflictingScheduleId: number
  conflictingScheduleName: string
  collidingShifts: ShiftDTO[]
}

export type ConflictResolution =
  /** Unassign the agent from `conflictingScheduleId`, then assign them here. */
  | 'free-the-agent'
  /** Leave the other schedule alone; this agent drops out of the batch. */
  | 'drop-from-batch'

// TODO(conflict-precheck): replace with the real endpoint once the contract is
// agreed. Returning `[]` means "nothing known to conflict", so today the modal
// behaves exactly as it did before the pre-check existed.
async function findAssignmentConflicts(_scheduleId: number, _agentIds: number[]): Promise<AssignmentConflict[]> {
  return []
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * Picking coverage is a set operation — "these four people work this shift" —
 * so the picker is a checkbox group, not a radio group, and one confirm covers
 * the whole set.
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
 * With the pre-check in front of it, a rejection *during* the write is either a
 * race (someone else edited the other schedule in the last second) or a genuine
 * fault. Either way the batch stops there rather than pressing on: the user's
 * picture of who is covered is already stale, and the honest thing is to say so
 * and let them look again.
 *
 * Already-assigned agents are filtered out rather than shown as disabled rows:
 * they are not a decision the user has to make, and hiding them keeps the list
 * short enough to scan.
 */
export function AssignAgentModal({ open, onOpenChange, scheduleId }: AssignAgentModalProps) {
  const { toast } = useToast()
  const agents = useAgents()
  const assignees = useScheduleAssignees(open ? scheduleId : null)
  const assign = useAssignAgent()

  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [conflicts, setConflicts] = useState<AssignmentConflict[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  // Assignments this batch already landed. The assignees query is invalidated
  // on every success, but until it comes back the list would still offer people
  // who are on the schedule now — and re-picking them earns a 409.
  const [assignedNow, setAssignedNow] = useState<number[]>([])
  const [isAssigning, setIsAssigning] = useState(false)

  const listRef = useRef<HTMLDivElement>(null)

  // Reopening for a different schedule must not inherit the previous answers —
  // a stale selection here would assign the wrong people in one click.
  useEffect(() => {
    if (open) {
      setSearch('')
      setSelectedIds([])
      setConflicts([])
      setProblem(null)
      setAssignedNow([])
      setIsAssigning(false)
    }
  }, [open, scheduleId])

  /** Everyone who can still be picked, ignoring the search box. */
  const available = useMemo(() => {
    const taken = new Set([...(assignees.data ?? []).map((a) => a.id), ...assignedNow])
    return (agents.data ?? []).filter((agent) => !taken.has(agent.id))
  }, [agents.data, assignees.data, assignedNow])

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

  const isLoading = agents.isLoading || assignees.isLoading
  const failed = agents.isError || assignees.isError

  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const allFilteredSelected = filtered.length > 0 && filtered.every((agent) => selected.has(agent.id))
  const anyFilteredSelected = filtered.some((agent) => selected.has(agent.id))

  function toggle(agentId: number) {
    setSelectedIds((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId],
    )
  }

  function selectAllFiltered() {
    setSelectedIds((current) => [
      ...current,
      ...filtered.filter((agent) => !current.includes(agent.id)).map((agent) => agent.id),
    ])
  }

  function clearAllFiltered() {
    const inView = new Set(filtered.map((agent) => agent.id))
    setSelectedIds((current) => current.filter((id) => !inView.has(id)))
  }

  /* Native checkboxes are Tab-navigable but not arrow-navigable, and a long
     directory is far quicker to walk with the arrows. Tab still works. */
  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const boxes = Array.from(listRef.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])
    const index = boxes.indexOf(document.activeElement as HTMLInputElement)
    if (index === -1) return
    event.preventDefault()
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1
    boxes[(next + boxes.length) % boxes.length]?.focus()
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
    if (scheduleId === null || selectedIds.length === 0 || isAssigning) return

    // Snapshotted before the first request: the list re-derives as each success
    // invalidates the assignees query, and this must keep naming the people the
    // user actually picked.
    const batch = available.filter((agent) => selected.has(agent.id))
    if (batch.length === 0) return

    setIsAssigning(true)
    setConflicts([])
    setProblem(null)

    // ── Nothing is written until the pre-check comes back clean. ────────────
    const found = await findAssignmentConflicts(
      scheduleId,
      batch.map((agent) => agent.id),
    )
    if (found.length > 0) {
      // TODO(conflict-precheck): this is where the resolution step attaches —
      // per conflict, "free the agent" (unassign from `conflictingScheduleId`)
      // or "drop from batch". Until it exists the batch simply does not run, so
      // a wired-up endpoint can never silently write through an unresolved
      // conflict.
      setConflicts(found)
      setIsAssigning(false)
      return
    }

    const assigned: typeof batch = []

    for (const agent of batch) {
      const outcome = await assignOne(scheduleId, agent.id)
      if (!outcome.ok) {
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

  const count = selectedIds.length

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

        {/* TODO(conflict-precheck): the two resolution controls hang off each of
            these rows once the contract lands. Listing them unresolved is the
            deliberate holding state — the batch is blocked, not written. */}
        {conflicts.map((conflict) => (
          <ConflictBanner
            key={conflict.agentId}
            message={`${conflict.agentName} is already on "${conflict.conflictingScheduleName}" during these hours.`}
          />
        ))}

        <Input
          label="Find an agent"
          placeholder="Name or email"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          disabled={isLoading || failed || isAssigning}
        />

        {isLoading && (
          <div className="flex flex-col gap-2" aria-busy="true">
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
                  disabled={isAssigning || allFilteredSelected}
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
                const isSelected = selected.has(agent.id)

                return (
                  <label
                    key={agent.id}
                    data-selected={isSelected || undefined}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 border-b border-[var(--color-hairline)] px-3 py-2.5 last:border-b-0',
                      isSelected ? 'bg-[var(--color-brand-100)]' : 'hover:bg-[var(--color-surface-sunken)]',
                    )}
                  >
                    {/* A native checkbox, so "selected" is in the accessibility
                        tree as a checked state rather than as a colour. */}
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--color-brand)]"
                      checked={isSelected}
                      disabled={isAssigning}
                      onChange={() => toggle(agent.id)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] text-[var(--color-ink-900)]">{agent.name}</span>
                      {agent.email && (
                        <span className="block truncate text-[12px] text-[var(--color-ink-500)]">{agent.email}</span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
