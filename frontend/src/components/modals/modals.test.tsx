import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '@/api/http'
import { AssignAgentModal } from './AssignAgentModal'
import { DeletionImpactModal } from './DeletionImpactModal'
import { Modal } from './Modal'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The queries and mutations are stubbed rather than driven through a real
 * QueryClient: every assertion below is about what the modal *does with an
 * answer* — blocks until one arrives, names the people in it, treats a 409 as
 * an answer rather than a fault — and a real client would only add timing.
 */
const mocks = vi.hoisted(() => {
  const idle = () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() })
  return {
    state: { agents: idle() as any, assignees: idle() as any, impact: idle() as any },
    idle,
    assignMutate: vi.fn(),
    deleteMutate: vi.fn(),
    toast: vi.fn(),
  }
})

vi.mock('@/hooks/queries', () => ({
  useAgents: () => mocks.state.agents,
  useScheduleAssignees: () => mocks.state.assignees,
  useDeletionImpact: () => mocks.state.impact,
}))

vi.mock('@/hooks/mutations', () => ({
  useAssignAgent: () => ({ mutate: mocks.assignMutate, isPending: false }),
  useDeleteSchedule: () => ({ mutate: mocks.deleteMutate, isPending: false }),
}))

vi.mock('@/context/ToastContext', () => ({ useToast: () => ({ toast: mocks.toast }) }))

const AGENTS = [
  { id: 1, name: 'Ana Rao', email: 'ana@example.com' },
  { id: 2, name: 'Bo Chen', email: 'bo@example.com' },
  { id: 3, name: 'Cyd Iyer', email: null },
]

const loaded = (data: unknown) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.agents = mocks.idle()
  mocks.state.assignees = mocks.idle()
  mocks.state.impact = mocks.idle()
})

describe('Modal', () => {
  function Harness({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
    const [open, setOpen] = useState(true)
    return (
      <>
        <button type="button">Outside</button>
        <Modal
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            onOpenChange(next)
          }}
          title="Edit hours"
          description="Weekly coverage for this schedule."
        >
          <button type="button">Inside one</button>
          <button type="button">Inside two</button>
        </Modal>
      </>
    )
  }

  it('is labelled and described by its own header', async () => {
    render(<Harness onOpenChange={vi.fn()} />)
    const dialog = await screen.findByRole('dialog')

    expect(dialog).toHaveAccessibleName('Edit hours')
    expect(dialog).toHaveAccessibleDescription('Weekly coverage for this schedule.')
  })

  it('traps focus inside the dialog', async () => {
    const user = userEvent.setup()
    render(<Harness onOpenChange={vi.fn()} />)
    const dialog = await screen.findByRole('dialog')

    // More tabs than there are focusables, so the trap has to wrap rather than
    // let focus escape to the "Outside" button behind the overlay.
    for (let i = 0; i < 6; i += 1) {
      await user.tab()
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    }
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<Harness onOpenChange={onOpenChange} />)
    await screen.findByRole('dialog')

    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('DeletionImpactModal', () => {
  it('blocks deletion until the impact has actually loaded', () => {
    mocks.state.impact = { ...mocks.idle(), isLoading: true }
    mocks.state.agents = loaded(AGENTS)

    render(<DeletionImpactModal open onOpenChange={vi.fn()} scheduleId={7} scheduleName="Night shift" />)

    expect(screen.getByRole('button', { name: /delete/i })).toBeDisabled()
    expect(mocks.deleteMutate).not.toHaveBeenCalled()
  })

  it('names every affected agent, and only those', async () => {
    const user = userEvent.setup()
    mocks.state.impact = loaded({ schedule_id: 7, affected_agent_ids: [1, 3] })
    mocks.state.agents = loaded(AGENTS)

    render(<DeletionImpactModal open onOpenChange={vi.fn()} scheduleId={7} scheduleName="Night shift" />)

    expect(screen.getByText(/2 agents lose coverage/i)).toBeInTheDocument()
    expect(screen.getByText('Ana Rao')).toBeInTheDocument()
    expect(screen.getByText('Cyd Iyer')).toBeInTheDocument()
    expect(screen.queryByText('Bo Chen')).toBeNull()

    const confirm = screen.getByRole('button', { name: /delete and affect 2 agents/i })
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    expect(mocks.deleteMutate).toHaveBeenCalledWith(7, expect.any(Object))
  })

  it('falls back to the id when the directory has not caught up', () => {
    mocks.state.impact = loaded({ schedule_id: 7, affected_agent_ids: [99] })
    mocks.state.agents = loaded(AGENTS)

    render(<DeletionImpactModal open onOpenChange={vi.fn()} scheduleId={7} />)

    // Under-reporting the damage is the one failure this flow must not have.
    expect(screen.getByText('Agent #99')).toBeInTheDocument()
  })

  it('stays light when nobody is affected', () => {
    mocks.state.impact = loaded({ schedule_id: 7, affected_agent_ids: [] })
    mocks.state.agents = loaded(AGENTS)

    render(<DeletionImpactModal open onOpenChange={vi.fn()} scheduleId={7} />)

    expect(screen.getByText(/no agents are assigned to this schedule/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete schedule' })).toBeEnabled()
  })
})

describe('AssignAgentModal', () => {
  /** The endpoint takes one agent per call, so the stub answers per agent. */
  function answerPerAgent(answers: Record<number, ApiError | undefined> = {}) {
    mocks.assignMutate.mockImplementation((input: any, options: any) => {
      const error = answers[input.agentId]
      if (error) options.onError(error)
      else options.onSuccess()
    })
  }

  const checkbox = (name: RegExp) => screen.getByRole('checkbox', { name })
  const finder = () => screen.getByPlaceholderText('Name or email')

  it('offers a real checkbox group, so selection is a state and not a colour', async () => {
    const user = userEvent.setup()
    mocks.state.agents = loaded(AGENTS)
    mocks.state.assignees = loaded([])

    render(<AssignAgentModal open onOpenChange={vi.fn()} scheduleId={7} />)

    const group = screen.getByRole('group', { name: 'Assignable agents' })
    expect(group).toBeInTheDocument()
    // Every row carries its own name, so a screen reader reads the person
    // rather than "checkbox, unchecked".
    expect(checkbox(/Ana Rao/)).not.toBeChecked()

    // Reachable and operable from the keyboard alone: focus the first box,
    // tick it with Space, walk down with the arrows, tick the next.
    checkbox(/Ana Rao/).focus()
    await user.keyboard(' ')
    expect(checkbox(/Ana Rao/)).toBeChecked()

    await user.keyboard('{ArrowDown}')
    expect(checkbox(/Bo Chen/)).toHaveFocus()
    await user.keyboard(' ')

    expect(checkbox(/Bo Chen/)).toBeChecked()
    expect(checkbox(/Cyd Iyer/)).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Assign 2 agents' })).toBeEnabled()
  })

  it('issues one assign request per selected agent', async () => {
    const user = userEvent.setup()
    mocks.state.agents = loaded(AGENTS)
    mocks.state.assignees = loaded([])
    answerPerAgent()

    render(<AssignAgentModal open onOpenChange={vi.fn()} scheduleId={7} />)

    await user.click(checkbox(/Ana Rao/))
    await user.click(checkbox(/Bo Chen/))
    await user.click(checkbox(/Cyd Iyer/))

    // The running count is what tells the user how big the batch is.
    await user.click(screen.getByRole('button', { name: 'Assign 3 agents' }))

    await waitFor(() => expect(mocks.assignMutate).toHaveBeenCalledTimes(3))
    // One request per agent, in the order they appear in the list.
    expect(mocks.assignMutate.mock.calls.map(([input]) => input)).toEqual([
      { scheduleId: 7, agentId: 1 },
      { scheduleId: 7, agentId: 2 },
      { scheduleId: 7, agentId: 3 },
    ])
  })

  it('toasts once for the whole batch and closes when every agent lands', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    mocks.state.agents = loaded(AGENTS)
    mocks.state.assignees = loaded([])
    answerPerAgent()

    render(<AssignAgentModal open onOpenChange={onOpenChange} scheduleId={7} />)

    await user.click(checkbox(/Ana Rao/))
    await user.click(checkbox(/Bo Chen/))
    await user.click(screen.getByRole('button', { name: 'Assign 2 agents' }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    // Two requests, one notification — a toast per agent would be noise.
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    expect(mocks.toast).toHaveBeenCalledWith({
      tone: 'success',
      message: '2 agents assigned to this schedule.',
    })
  })

  it('renders a 409 inline instead of throwing', async () => {
    const user = userEvent.setup()
    mocks.state.agents = loaded(AGENTS)
    mocks.state.assignees = loaded([])
    answerPerAgent({
      1: new ApiError(
        'conflict',
        409,
        'agent_schedule_conflict',
        'Ana Rao already works 09:00-17:00 on "Day shift".',
      ),
    })

    render(<AssignAgentModal open onOpenChange={vi.fn()} scheduleId={7} />)

    await user.click(checkbox(/Ana Rao/))
    await user.click(screen.getByRole('button', { name: 'Assign 1 agent' }))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('Ana Rao')
    expect(banner).toHaveTextContent('already works 09:00-17:00')
    // An expected rejection belongs next to the control, not in a toast that
    // outlives the context that makes it fixable.
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(checkbox(/Ana Rao/)).toBeChecked()
  })

  it('stops the batch on a rejection and does not pretend the writes were undone', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    mocks.state.agents = loaded(AGENTS)
    mocks.state.assignees = loaded([])
    answerPerAgent({
      2: new ApiError('conflict', 409, 'agent_schedule_conflict', 'Bo Chen already works 09:00-17:00.'),
    })

    render(<AssignAgentModal open onOpenChange={onOpenChange} scheduleId={7} />)

    await user.click(checkbox(/Ana Rao/))
    await user.click(checkbox(/Bo Chen/))
    await user.click(checkbox(/Cyd Iyer/))
    await user.click(screen.getByRole('button', { name: 'Assign 3 agents' }))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('Bo Chen already works 09:00-17:00')
    // Ana went through before Bo was rejected, and she really is assigned.
    expect(banner).toHaveTextContent(/1 agent assigned before this \(Ana Rao\)/)
    expect(banner).toHaveTextContent(/nothing was undone/i)

    // Cyd was never attempted: the batch stops rather than pressing on.
    expect(mocks.assignMutate).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
    // Ana drops out of the picker — she is assigned now — and is no longer part
    // of a retry, while the untouched pair stay ticked.
    expect(screen.queryByRole('checkbox', { name: /Ana Rao/ })).toBeNull()
    expect(checkbox(/Bo Chen/)).toBeChecked()
    expect(checkbox(/Cyd Iyer/)).toBeChecked()
    expect(screen.getByRole('button', { name: 'Assign 2 agents' })).toBeEnabled()
  })

  it('leaves out agents who are already assigned', () => {
    mocks.state.agents = loaded(AGENTS)
    mocks.state.assignees = loaded([{ id: 1, name: 'Ana Rao' }])

    render(<AssignAgentModal open onOpenChange={vi.fn()} scheduleId={7} />)

    expect(screen.queryByRole('checkbox', { name: /Ana Rao/ })).toBeNull()
    expect(checkbox(/Bo Chen/)).toBeInTheDocument()
    expect(checkbox(/Cyd Iyer/)).toBeInTheDocument()
  })

  it('filters the list as the user searches', async () => {
    const user = userEvent.setup()
    mocks.state.agents = loaded(AGENTS)
    mocks.state.assignees = loaded([])

    render(<AssignAgentModal open onOpenChange={vi.fn()} scheduleId={7} />)

    await user.type(finder(), 'cyd')

    expect(checkbox(/Cyd Iyer/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Ana Rao/ })).toBeNull()
  })

  it('select all takes the filtered set only, and the selection survives the filter', async () => {
    const user = userEvent.setup()
    mocks.state.agents = loaded(AGENTS)
    mocks.state.assignees = loaded([])

    render(<AssignAgentModal open onOpenChange={vi.fn()} scheduleId={7} />)

    // "o" matches Ana Rao and Bo Chen, but not Cyd Iyer.
    await user.type(finder(), 'o')
    await user.click(screen.getByRole('button', { name: 'Select all' }))

    expect(screen.getByRole('button', { name: 'Assign 2 agents' })).toBeEnabled()

    await user.clear(finder())

    expect(checkbox(/Ana Rao/)).toBeChecked()
    expect(checkbox(/Bo Chen/)).toBeChecked()
    // The agent who was off screen was never swept up …
    expect(checkbox(/Cyd Iyer/)).not.toBeChecked()
    // … and hiding a row does not silently drop it from the batch either.
    expect(screen.getByRole('button', { name: 'Assign 2 agents' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(screen.getByRole('button', { name: 'Assign agents' })).toBeDisabled()
  })

  it('will not assign with nothing selected', () => {
    mocks.state.agents = loaded(AGENTS)
    mocks.state.assignees = loaded([])

    render(<AssignAgentModal open onOpenChange={vi.fn()} scheduleId={7} />)

    expect(screen.getByRole('button', { name: 'Assign agents' })).toBeDisabled()
    expect(screen.getByText('No agents selected')).toBeInTheDocument()
    expect(mocks.assignMutate).not.toHaveBeenCalled()
  })
})
