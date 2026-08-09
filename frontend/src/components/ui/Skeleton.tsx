import { forwardRef, type HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export type SkeletonProps = HTMLAttributes<HTMLDivElement>

/**
 * A placeholder block. Hidden from assistive tech by default — a screen reader
 * announcing five grey rectangles is worse than silence; the loading state is
 * communicated by the region's own `aria-busy`.
 */
export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(function Skeleton(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn('h-4 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-hairline)]', className)}
      {...props}
    />
  )
})
