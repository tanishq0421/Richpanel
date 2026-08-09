import type { ReactNode } from 'react'
import { Button } from '@/components/ui'
import { Modal } from './Modal'

export interface ConfirmModalProps {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: ReactNode
  confirmLabel?: string
  tone?: 'default' | 'danger'
  loading?: boolean
  onConfirm: () => void
}

/**
 * The generic two-button confirmation. Deliberately thin: anything that needs
 * to *explain a consequence* (who loses coverage, what stops being measured)
 * should not be squeezed in here — see `DeletionImpactModal`, which is its own
 * flow precisely because "are you sure?" is not an adequate question when the
 * answer depends on data the user cannot see.
 */
export function ConfirmModal({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  tone = 'default',
  loading = false,
  onConfirm,
}: ConfirmModalProps) {
  // A plain string can be wired straight into `aria-describedby` via Modal's
  // own Description; rich content cannot, so it renders as body instead.
  const descriptionIsText = typeof description === 'string'

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={descriptionIsText ? description : undefined}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {!descriptionIsText && description && (
        <div className="text-[13px] text-[var(--color-ink-700)]">{description}</div>
      )}
    </Modal>
  )
}
