import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { cn } from '@/lib/cn'
import { hhmmToHours, timeOptions } from '@/helpers/time'
import {
  FIELD_LABEL_CLASS,
  POPOVER_CLASS,
  TRIGGER_CLASS,
  triggerBorder,
} from './DatePicker'

/** Every quarter hour of the day. Constant: the list never varies at runtime. */
const OPTIONS = timeOptions()

/** How long consecutive keystrokes count as one typeahead word. */
const TYPEAHEAD_WINDOW_MS = 800

/** A quarter-hour step is 1 row; PageUp/PageDown move a whole hour. */
const ROWS_PER_HOUR = 4

/**
 * Snap an arbitrary value onto the list. An exact hit is the normal case; the
 * nearest-minute fallback exists so a value that predates a step change (or
 * arrives from the API off-grid) still opens with a sensible row highlighted
 * instead of silently jumping to midnight.
 */
function indexForValue(value: string): number {
  const exact = OPTIONS.indexOf(value)
  if (exact !== -1) return exact

  let target: number
  try {
    target = hhmmToHours(value)
  } catch {
    return 0
  }

  let best = 0
  let bestDelta = Number.POSITIVE_INFINITY
  OPTIONS.forEach((option, index) => {
    const delta = Math.abs(hhmmToHours(option) - target)
    if (delta < bestDelta) {
      bestDelta = delta
      best = index
    }
  })
  return best
}

/**
 * "22" → 22:00, "9" → 09:00. The zero-pad retry is what makes single-digit
 * hours reachable at all: no option literally starts with "9".
 */
function indexForTypeahead(buffer: string): number {
  const direct = OPTIONS.findIndex((option) => option.startsWith(buffer))
  if (direct !== -1) return direct
  if (/^\d$/.test(buffer)) return OPTIONS.findIndex((option) => option.startsWith(`0${buffer}`))
  return -1
}

function ClockIcon() {
  return (
    <svg
      className="size-4 shrink-0 text-[var(--color-ink-400)]"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.75V8l2.25 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

export interface TimePickerProps {
  value: string
  onChange: (v: string) => void
  label?: string
  error?: string
  'aria-label'?: string
  id?: string
  disabled?: boolean
}

/**
 * A listbox of quarter-hour options, not a text box: the value the caller
 * receives is always one of `timeOptions()`, so no parsing, no "25:70", and no
 * rounding drift against the float wire format.
 *
 * Focus lives on the listbox and the active row is published through
 * `aria-activedescendant` (ARIA APG listbox pattern) — that keeps arrow keys,
 * Home/End, PageUp/PageDown and typeahead on one element instead of scattering
 * a roving tabindex across 96 rows.
 */
export function TimePicker({
  value,
  onChange,
  label,
  error,
  'aria-label': ariaLabel,
  id,
  disabled,
}: TimePickerProps) {
  const generatedId = useId()
  const triggerId = id ?? `time-${generatedId}`
  const labelId = `${triggerId}-label`
  const messageId = `${triggerId}-message`
  const valueId = `${triggerId}-value`
  const listboxId = `${triggerId}-listbox`
  const optionId = (index: number) => `${triggerId}-option-${index}`

  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(() => indexForValue(value))

  const listRef = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ buffer: '', at: 0 })

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex])

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setActiveIndex(indexForValue(value))
      typeahead.current = { buffer: '', at: 0 }
    }
  }

  function commit(index: number) {
    onChange(OPTIONS[index])
    setOpen(false)
  }

  function move(delta: number) {
    setActiveIndex((current) => Math.min(OPTIONS.length - 1, Math.max(0, current + delta)))
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        return move(1)
      case 'ArrowUp':
        event.preventDefault()
        return move(-1)
      case 'PageDown':
        event.preventDefault()
        return move(ROWS_PER_HOUR)
      case 'PageUp':
        event.preventDefault()
        return move(-ROWS_PER_HOUR)
      case 'Home':
        event.preventDefault()
        return setActiveIndex(0)
      case 'End':
        event.preventDefault()
        return setActiveIndex(OPTIONS.length - 1)
      case 'Enter':
      case ' ':
        event.preventDefault()
        return commit(activeIndex)
      default:
        break
    }

    // Escape is left to Radix, which also returns focus to the trigger.
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return

    const now = Date.now()
    const buffer =
      now - typeahead.current.at > TYPEAHEAD_WINDOW_MS
        ? event.key
        : typeahead.current.buffer + event.key
    typeahead.current = { buffer, at: now }

    const found = indexForTypeahead(buffer)
    if (found !== -1) {
      event.preventDefault()
      setActiveIndex(found)
    }
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      handleOpenChange(true)
    }
  }

  // An explicit `aria-label` overrides the visible label as the name, but the
  // trigger's own text is always appended so the current time is announced too.
  const overrideId = `${triggerId}-name`
  const hasOverride = Boolean(ariaLabel && ariaLabel !== label)
  const nameSourceId = hasOverride ? overrideId : label ? labelId : undefined

  return (
    <div className="flex w-full flex-col gap-1.5">
      {label && (
        <label id={labelId} htmlFor={triggerId} className={FIELD_LABEL_CLASS}>
          {label}
        </label>
      )}
      {hasOverride && (
        <span id={overrideId} className="sr-only">
          {ariaLabel}
        </span>
      )}

      <Popover.Root open={open} onOpenChange={handleOpenChange}>
        <Popover.Trigger asChild>
          <button
            type="button"
            id={triggerId}
            disabled={disabled}
            aria-labelledby={nameSourceId ? `${nameSourceId} ${valueId}` : undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? messageId : undefined}
            onKeyDown={handleTriggerKeyDown}
            className={cn(TRIGGER_CLASS, triggerBorder(error))}
          >
            <ClockIcon />
            <span id={valueId} className="tabular">
              {value}
            </span>
          </button>
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            className={cn(POPOVER_CLASS, 'p-1')}
            aria-label={ariaLabel ?? label ?? 'Choose a time'}
            /* Focus goes to the listbox itself, not to the first row: the
               active row is published via aria-activedescendant instead. */
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              listRef.current?.focus()
            }}
          >
            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              tabIndex={-1}
              aria-label={ariaLabel ?? label ?? 'Time'}
              aria-activedescendant={optionId(activeIndex)}
              onKeyDown={handleListKeyDown}
              className="max-h-64 w-[132px] overflow-y-auto outline-none"
            >
              {OPTIONS.map((option, index) => (
                <div
                  key={option}
                  id={optionId(index)}
                  role="option"
                  aria-selected={option === value}
                  data-active={index === activeIndex || undefined}
                  onClick={() => commit(index)}
                  className={cn(
                    'tabular cursor-pointer rounded-[var(--radius-md)] px-3 py-1.5 text-[13px] text-[var(--color-ink-900)]',
                    index === activeIndex &&
                      'bg-[var(--color-brand-100)] ring-1 ring-[var(--color-brand)] ring-inset',
                    option === value && 'bg-[var(--color-brand)] font-semibold text-white',
                  )}
                >
                  {option}
                </div>
              ))}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {error && (
        <p id={messageId} className="text-[13px] text-[var(--color-conflict)]">
          {error}
        </p>
      )}
    </div>
  )
}
