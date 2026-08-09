import { useState } from 'react'

import { ApiError } from '@/api/http'
import { EmptyState, ErrorState } from '@/components/feedback'
import { Badge, Button, Card, Skeleton } from '@/components/ui'
import { AssignAgentModal } from '@/components/modals'
import { useToast } from '@/context/ToastContext'
import { userMessage } from '@/helpers/errors'
import { useUnassignAgent } from '@/hooks/mutations'
import { useScheduleAssignees } from '@/hooks/queries'

export function AssigneeList({ scheduleId }: { scheduleId: number }) {
  const assignees = useScheduleAssignees(scheduleId)
  const unassign = useUnassignAgent()
  const { toast } = useToast()

  const [assignOpen, setAssignOpen] = useState(false)
  // Removing coverage is destructive enough to confirm, but not destructive
  // enough to warrant a modal on top of a modal — the row confirms in place.
  const [confirmingId, setConfirmingId] = useState<number | null>(null)

  function handleRemove(agentId: number, agentName: string) {
    unassign.mutate(
      { scheduleId, agentId },
      {
        onSuccess: () => {
          setConfirmingId(null)
          toast({ tone: 'success', message: `${agentName} removed from this schedule.` })
        },
      },
    )
  }

  const rows = assignees.data

  return (
    <>
      <Card
        title="Assigned agents"
        actions={
          <Button size="sm" variant="secondary" onClick={() => setAssignOpen(true)}>
            Assign agent
          </Button>
        }
      >
        {/* An unassign that fails leaves the row on screen — say why, rather than
            letting the row silently stay put and look like a bug. */}
        {unassign.error ? (
          <div
            role="alert"
            className="mb-3 rounded-[var(--radius-md)] border border-[var(--color-conflict)]/25 bg-[var(--color-conflict-bg)] px-3 py-2.5 text-[13px] text-[var(--color-conflict)]"
          >
            {unassign.error instanceof ApiError && unassign.error.kind === 'conflict'
              ? unassign.error.message
              : userMessage(unassign.error)}
          </div>
        ) : null}

        {assignees.isLoading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading assigned agents">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-9 w-full" />
            ))}
          </div>
        ) : assignees.error ? (
          <ErrorState error={assignees.error} onRetry={() => void assignees.refetch()} />
        ) : !rows || rows.length === 0 ? (
          <EmptyState
            title="No agents assigned"
            description="Agents assigned here are credited with these hours in the resolution time report."
            action={
              <Button size="sm" onClick={() => setAssignOpen(true)}>
                Assign agent
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-[var(--color-hairline)]">
            {rows.map((agent) => (
              <li key={agent.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="truncate text-[13px] text-[var(--color-ink-900)]">{agent.name}</span>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {confirmingId === agent.id ? (
                    <>
                      <span className="text-[12px] text-[var(--color-ink-500)]">Remove from schedule?</span>
                      <Button
                        size="sm"
                        variant="danger"
                        loading={unassign.isPending}
                        disabled={unassign.isPending}
                        onClick={() => handleRemove(agent.id, agent.name)}
                      >
                        Remove
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={unassign.isPending}
                        onClick={() => setConfirmingId(null)}
                      >
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingId(agent.id)}
                      aria-label={`Remove ${agent.name} from this schedule`}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {rows && rows.length > 0 ? (
          <p className="mt-3 border-t border-[var(--color-hairline)] pt-3 text-[12px] text-[var(--color-ink-400)]">
            <Badge tone="neutral">{rows.length} assigned</Badge>
          </p>
        ) : null}
      </Card>

      <AssignAgentModal open={assignOpen} onOpenChange={setAssignOpen} scheduleId={scheduleId} />
    </>
  )
}
