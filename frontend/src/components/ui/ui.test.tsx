import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ApiError } from '@/api/http'
import { Badge, Button, Card, Input, Select, Skeleton } from '@/components/ui'
import { ConflictBanner, EmptyState, ErrorState } from '@/components/feedback'

describe('Button', () => {
  it('is disabled while loading but keeps its accessible name', () => {
    render(<Button loading>Save</Button>)

    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('keeps the label in the layout while loading so the width does not jump', () => {
    render(<Button loading>Save schedule</Button>)

    // The label is faded, not removed — `display:none`/`visibility:hidden`
    // would collapse the box and shrink the button mid-save.
    const label = screen.getByText('Save schedule')
    expect(label).toHaveClass('opacity-0')
    expect(label.className).not.toMatch(/\b(hidden|invisible)\b/)
  })

  it('does not fire onClick while loading', async () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Save' }), { pointerEventsCheck: 0 })
    expect(onClick).not.toHaveBeenCalled()
  })

  it('fires onClick when idle and forwards a ref', async () => {
    const onClick = vi.fn()
    const ref = { current: null as HTMLButtonElement | null }
    render(
      <Button ref={ref} variant="danger" onClick={onClick}>
        Delete
      </Button>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })
})

describe('Input', () => {
  it('sets aria-invalid and links the error message to the field', () => {
    render(<Input label="Start time" error="End time must be after start time." />)

    const input = screen.getByLabelText('Start time')
    expect(input).toHaveAttribute('aria-invalid', 'true')

    const messageId = input.getAttribute('aria-describedby')
    expect(messageId).toBeTruthy()
    expect(document.getElementById(messageId as string)).toHaveTextContent(
      'End time must be after start time.',
    )
  })

  it('links the hint when there is no error and stays valid', () => {
    render(<Input label="Agent" hint="Search by name or email." />)

    const input = screen.getByLabelText('Agent')
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(document.getElementById(input.getAttribute('aria-describedby') as string)).toHaveTextContent(
      'Search by name or email.',
    )
  })

  it('gives each instance a distinct generated id', () => {
    render(
      <>
        <Input label="First" />
        <Input label="Second" />
      </>,
    )

    expect(screen.getByLabelText('First').id).not.toBe(screen.getByLabelText('Second').id)
  })
})

describe('Select', () => {
  it('renders its options and wires the error message', () => {
    render(
      <Select
        label="Weekday"
        error="Pick a weekday."
        options={[
          { value: 0, label: 'Monday' },
          { value: 1, label: 'Tuesday' },
        ]}
      />,
    )

    const select = screen.getByLabelText('Weekday')
    expect(screen.getByRole('option', { name: 'Monday' })).toBeInTheDocument()
    expect(select).toHaveAttribute('aria-invalid', 'true')
    expect(document.getElementById(select.getAttribute('aria-describedby') as string)).toHaveTextContent(
      'Pick a weekday.',
    )
  })
})

describe('Badge', () => {
  it('maps the conflict tone onto the conflict tokens', () => {
    render(<Badge tone="conflict">Overlaps</Badge>)

    const badge = screen.getByText('Overlaps')
    expect(badge.className).toContain('var(--color-conflict)')
    expect(badge.className).toContain('var(--color-conflict-bg)')
  })

  it('renders zero hours in grey — it is information, never an error', () => {
    render(<Badge tone="zero">0h</Badge>)

    const badge = screen.getByText('0h')
    expect(badge.className).toContain('var(--color-zero)')
    expect(badge.className).not.toContain('conflict')
  })

  it('uses the brand tokens for the brand tone', () => {
    render(<Badge tone="brand">Covered</Badge>)

    const badge = screen.getByText('Covered')
    expect(badge.className).toContain('var(--color-brand)')
    expect(badge.className).toContain('var(--color-brand-100)')
  })
})

describe('ErrorState', () => {
  it('renders a friendly message for an ApiError rather than the raw error', () => {
    const error = new ApiError('network', 0, 'network_error', 'Could not reach the server.')
    render(<ErrorState error={error} />)

    expect(
      screen.getByText('Could not reach the server. Check your connection and try again.'),
    ).toBeInTheDocument()
  })

  it('shows Retry only when onRetry is given, and calls it', async () => {
    const onRetry = vi.fn()
    const error = new ApiError('server', 500, 'internal', 'Traceback (most recent call last)')

    const { rerender } = render(<ErrorState error={error} />)
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    // The developer-facing text never reaches the screen.
    expect(screen.queryByText(/Traceback/)).not.toBeInTheDocument()

    rerender(<ErrorState error={error} onRetry={onRetry} />)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('falls back to a generic message for a non-ApiError', () => {
    render(<ErrorState error={new TypeError('x.map is not a function')} />)

    expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument()
    expect(screen.queryByText(/is not a function/)).not.toBeInTheDocument()
  })
})

describe('ConflictBanner', () => {
  it('announces itself as an alert and dismisses on request', async () => {
    const onDismiss = vi.fn()
    render(<ConflictBanner message="Priya already works 10:00–14:00 on Monday." onDismiss={onDismiss} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Priya already works 10:00–14:00 on Monday.')

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('has no dismiss control when it cannot be dismissed', () => {
    render(<ConflictBanner message="Overlapping shift." />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('Card, EmptyState and Skeleton', () => {
  it('renders a card header only when a title or actions are given', () => {
    const { rerender } = render(<Card>Body</Card>)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()

    rerender(
      <Card title="Weekly schedule" actions={<Button size="sm">Add</Button>}>
        Body
      </Card>,
    )
    expect(screen.getByRole('heading', { name: 'Weekly schedule' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })

  it('renders the empty state with its optional action', () => {
    render(
      <EmptyState
        title="No schedules yet"
        description="Add the first shift to start building coverage."
        action={<Button size="sm">Add shift</Button>}
      />,
    )

    expect(screen.getByText('No schedules yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add shift' })).toBeInTheDocument()
  })

  it('hides skeletons from assistive technology', () => {
    const { container } = render(<Skeleton className="h-8 w-40" />)

    const skeleton = container.firstElementChild as HTMLElement
    expect(skeleton).toHaveAttribute('aria-hidden', 'true')
    // tailwind-merge lets the caller override the default height.
    expect(skeleton.className).toContain('h-8')
    expect(skeleton.className).not.toContain('h-4')
  })
})
