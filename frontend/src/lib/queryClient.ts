import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api/http'

/**
 * Retry only what can plausibly succeed on a second attempt. The default
 * (3 retries on everything) turns a 404 or a 422 into four identical failed
 * requests and a four-times-longer wait before the user sees the message.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => error instanceof ApiError && error.isRetryable && failureCount < 2,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      // Never auto-retry a write: a timed-out POST may well have succeeded, and
      // retrying would create a second schedule or a duplicate assignment.
      retry: false,
    },
  },
})
