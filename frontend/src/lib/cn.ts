import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Conditional classes (clsx) followed by conflict resolution (tailwind-merge).
 *
 * The merge step is what makes every component below composable: a caller can
 * pass `className="h-11"` to a Button and win over the variant's `h-9` instead
 * of the two fighting on specificity-by-source-order, which is unpredictable
 * once Tailwind reorders utilities at build time.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
