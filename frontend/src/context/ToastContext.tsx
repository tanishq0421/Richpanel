import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ToastTone = 'success' | 'error' | 'info'

export interface ToastInput {
  tone: ToastTone
  message: string
}

interface ToastRecord extends ToastInput {
  id: number
}

interface ToastContextValue {
  toast: (t: ToastInput) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

/** Long enough to read a sentence, short enough not to stack up. */
const AUTO_DISMISS_MS = 5_000

let nextId = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id))
  }, [])

  // Stable identity: `toast` ends up in the dependency array of every effect
  // that reports a mutation result, and a new function each render would
  // re-fire them.
  const toast = useCallback((input: ToastInput) => {
    setToasts((current) => [...current, { ...input, id: nextId++ }])
  }, [])

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* One live region that persists across toasts. Screen readers announce
          children as they are added; `polite` waits for a pause rather than
          cutting off whatever the user is currently reading. */}
      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'fixed',
          bottom: '1.5rem',
          right: '1.5rem',
          zIndex: 60,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          width: 'min(22rem, calc(100vw - 3rem))',
          pointerEvents: 'none',
        }}
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({ toast, onDismiss }: { toast: ToastRecord; onDismiss: (id: number) => void }) {
  const { id } = toast

  useEffect(() => {
    const timer = setTimeout(() => onDismiss(id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [id, onDismiss])

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.75rem',
        padding: '0.75rem 0.875rem',
        background: 'var(--color-ink-900)',
        color: '#ffffff',
        borderRadius: 'var(--radius-md)',
        borderLeft: `4px solid ${toast.tone === 'error' ? 'var(--color-conflict)' : 'var(--color-brand)'}`,
        boxShadow: '0 6px 20px rgba(16, 24, 40, 0.22)',
        pointerEvents: 'auto',
      }}
    >
      <span style={{ flex: 1, lineHeight: 1.45 }}>{toast.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(id)}
        aria-label="Dismiss notification"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          opacity: 0.7,
          fontSize: '1rem',
          lineHeight: 1,
          padding: '0.125rem',
        }}
      >
        &times;
      </button>
    </div>
  )
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used inside a <ToastProvider>.')
  }
  return context
}
