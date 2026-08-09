import { useMemo } from 'react'
import { Badge, Button, Skeleton } from '@/components/ui'
import { ErrorState } from '@/components/feedback'
import { useAgents, useDeletionImpact } from '@/hooks/queries'
import { useDeleteSchedule } from '@/hooks/mutations'
import { useToast } from '@/context/ToastContext'
import { userMessage } from '@/helpers/errors'
import { Modal } from './Modal'

export interface DeletionImpactModalProps {
  open: boolean
  onOpenChange: (o: boolean) => void
  scheduleId: number | null
  scheduleName?: string
  onDeleted?: () => void
}

/**
 * Deleting a schedule silently zeroes out coverage for everyone assigned to it,
 * and the person clicking Delete usually cannot remember who that is. So this
 * is not a confirmation dialog with a scary colour — it is a short report that
 * happens to end in a button.
 *
 * Two things follow from that:
 *  - the impact is fetched only when the modal opens (`scheduleId` is passed as
 *    `null` while closed, which disables the query). A count read from a list
 *    render minutes ago would be stale exactly when it matters most.
 *  - Delete stays disabled until the impact has actually loaded. Confirming a
 *    consequence you were never shown is the failure mode this whole flow
 *    exists to prevent, so an unanswered request must block, not default to
 *    "probably fine".
 *
 * `affected_agent_ids` carries ids only; names come from the agent directory,
 * which is already cached. Ids are useless to the reader — the entire product
 * decision here is "show them by name".
 */
export function DeletionImpactModal({
  open,
  onOpenChange,
  scheduleId,
  scheduleName,
  onDeleted,
}: DeletionImpactModalProps) {
  const { toast } = useToast()
  const impact = useDeletionImpact(open ? scheduleId : null)
  const agents = useAgents()
  const deleteSchedule = useDeleteSchedule()

  const affected = useMemo(() => {
    const ids = impact.data?.affected_agent_ids ?? []
    const byId = new Map((agents.data ?? []).map((agent) => [agent.id, agent]))
    // An id with no matching agent means the directory is a request behind the
    // impact response. Showing the raw id is honest; dropping the row would
    // under-report the damage, which is the one error that must not happen.
    return ids.map((id) => byId.get(id)?.name ?? `Agent #${id}`)
  }, [impact.data, agents.data])

  const isLoading = impact.isLoading || agents.isLoading
  const failed = impact.isError || agents.isError
  const ready = !isLoading && !failed && impact.data !== undefined
  const count = affected.length

  function handleDelete() {
    if (scheduleId === null) return
    deleteSchedule.mutate(scheduleId, {
      onSuccess: () => {
        toast({
          tone: 'success',
          message: scheduleName ? `Deleted "${scheduleName}".` : 'Schedule deleted.',
        })
        onOpenChange(false)
        onDeleted?.()
      },
      onError: (error) => toast({ tone: 'error', message: userMessage(error) }),
    })
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={scheduleName ? `Delete "${scheduleName}"?` : 'Delete this schedule?'}
      description="Deleting removes the schedule and every hour it contributes. This cannot be undone."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={deleteSchedule.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={deleteSchedule.isPending}
            disabled={!ready || scheduleId === null}
            onClick={handleDelete}
          >
            {ready && count > 0 ? `Delete and affect ${count} ${count === 1 ? 'agent' : 'agents'}` : 'Delete schedule'}
          </Button>
        </>
      }
    >
      <div aria-busy={isLoading || undefined}>
        {isLoading && (
          <div className="flex flex-col gap-2.5">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-16 w-full" />
            <p className="sr-only">Checking who this affects…</p>
          </div>
        )}

        {!isLoading && failed && (
          <ErrorState
            error={impact.error ?? agents.error}
            onRetry={() => {
              if (impact.isError) void impact.refetch()
              if (agents.isError) void agents.refetch()
            }}
          />
        )}

        {ready && count === 0 && (
          // Zero affected is genuinely low-stakes, so it is styled as such —
          // no impact colour, no list, no weight it has not earned.
          <p className="text-[13px] text-[var(--color-ink-700)]">
            No agents are assigned to this schedule, so deleting it will not change anyone&apos;s coverage.
          </p>
        )}

        {ready && count > 0 && (
          <div className="rounded-[var(--radius-md)] border border-[color-mix(in_srgb,var(--color-impact)_28%,transparent)] bg-[var(--color-impact-bg)] p-4">
            <p className="font-[family-name:var(--font-display)] text-[14px] font-semibold tracking-tight text-[var(--color-impact)]">
              {count} {count === 1 ? 'agent loses' : 'agents lose'} coverage from this schedule
            </p>
            <p className="mt-1 text-[13px] text-[var(--color-ink-700)]">
              {count === 1 ? 'This agent is' : 'These agents are'} assigned to it. Their working hours from this
              schedule disappear, and any resolution-time report generated afterwards will measure them without it.
            </p>

            <ul className="mt-3 flex flex-wrap gap-1.5">
              {affected.map((name, index) => (
                <li key={`${name}-${index}`}>
                  <Badge tone="impact">{name}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
