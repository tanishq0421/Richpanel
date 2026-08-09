import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Skeleton } from '@/components/ui'
import { ConflictBanner, EmptyState, ErrorState } from '@/components/feedback'
import { useAgents, useScheduleAssignees } from '@/hooks/queries'
import { useAssignAgent } from '@/hooks/mutations'
import { useToast } from '@/context/ToastContext'
import { isExpectedRejection, userMessage } from '@/helpers/errors'
import { Modal } from './Modal'

export interface AssignAgentModalProps {
  open: boolean
  onOpenChange: (o: boolean) => void
  scheduleId: number | null
}

/**
 * Assigning is the one action in this product with a routine, *expected* server
 * rejection: a 409 when the agent's hours would overlap another schedule they
 * are already on. The backend is the only thing that can answer that question —
 * it needs every other schedule the agent holds — so the UI cannot pre-empt it.
 *
 * The consequence is that a 409 must be treated as an answer, not a fault: it
 * lands in a `ConflictBanner` above the list, the picker keeps its state, and
 * the user can pick someone else without reopening anything. Throwing it at an
 * error boundary or a toast would discard the context that makes it fixable.
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
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)

  // Reopening for a different schedule must not inherit the previous answer —
  // a stale selection here would assign the wrong person in one click.
  useEffect(() => {
    if (open) {
      setSearch('')
      setSelectedId(null)
      setConflict(null)
    }
  }, [open, scheduleId])

  const assignable = useMemo(() => {
    const taken = new Set((assignees.data ?? []).map((a) => a.id))
    const needle = search.trim().toLowerCase()
    return (agents.data ?? [])
      .filter((agent) => !taken.has(agent.id))
      .filter(
        (agent) =>
          needle === '' ||
          agent.name.toLowerCase().includes(needle) ||
          (agent.email ?? '').toLowerCase().includes(needle),
      )
  }, [agents.data, assignees.data, search])

  const isLoading = agents.isLoading || assignees.isLoading
  const failed = agents.isError || assignees.isError

  function handleAssign() {
    if (scheduleId === null || selectedId === null) return
    setConflict(null)

    assign.mutate(
      { scheduleId, agentId: selectedId },
      {
        onSuccess: () => {
          const name = assignable.find((a) => a.id === selectedId)?.name ?? 'Agent'
          toast({ tone: 'success', message: `${name} assigned to this schedule.` })
          onOpenChange(false)
        },
        onError: (error) => {
          // 409 (and a 422) are business-rule answers — inline, next to the
          // control that caused them. Anything else is a genuine fault.
          if (isExpectedRejection(error)) setConflict(userMessage(error))
          else toast({ tone: 'error', message: userMessage(error) })
        },
      },
    )
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Assign an agent"
      description="An agent can only be on one schedule at a time for any given hour."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={assign.isPending}>
            Cancel
          </Button>
          <Button
            loading={assign.isPending}
            disabled={selectedId === null || scheduleId === null}
            onClick={handleAssign}
          >
            Assign
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {conflict && <ConflictBanner message={conflict} onDismiss={() => setConflict(null)} />}

        <Input
          label="Find an agent"
          placeholder="Name or email"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          disabled={isLoading || failed}
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

        {!isLoading && !failed && assignable.length === 0 && (
          <EmptyState
            title={search.trim() ? 'No agents match that search' : 'Everyone is already assigned'}
            description={
              search.trim()
                ? 'Try a different name or email.'
                : 'Every agent in the directory is already on this schedule.'
            }
          />
        )}

        {!isLoading && !failed && assignable.length > 0 && (
          <div
            role="radiogroup"
            aria-label="Assignable agents"
            className="max-h-[280px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-hairline)]"
          >
            {assignable.map((agent) => (
              <label
                key={agent.id}
                className="flex cursor-pointer items-center gap-3 border-b border-[var(--color-hairline)] px-3 py-2.5 last:border-b-0 hover:bg-[var(--color-surface-sunken)]"
              >
                <input
                  type="radio"
                  name="assign-agent"
                  className="size-4 accent-[var(--color-brand)]"
                  checked={selectedId === agent.id}
                  onChange={() => {
                    setSelectedId(agent.id)
                    setConflict(null)
                  }}
                />
                <span className="min-w-0">
                  <span className="block truncate text-[14px] text-[var(--color-ink-900)]">{agent.name}</span>
                  {agent.email && (
                    <span className="block truncate text-[12px] text-[var(--color-ink-500)]">{agent.email}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
