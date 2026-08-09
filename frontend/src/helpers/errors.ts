import { ApiError } from '@/api/http'

/**
 * One place that turns a failure into something a support manager can act on.
 * Backend messages are accurate but written for developers; these are written
 * for the person looking at the screen.
 */
export function userMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Something went wrong. Please try again.'
  }

  switch (error.kind) {
    case 'network':
      return 'Could not reach the server. Check your connection and try again.'
    case 'timeout':
      return 'The server took too long to respond. Try again in a moment.'
    case 'not_found':
      return 'That item no longer exists. It may have been deleted by someone else.'
    case 'conflict':
      // The backend's conflict message names the agent and the reason, and is
      // the most useful thing we can show until it returns structured detail.
      return error.message
    case 'validation':
      return error.details.length === 1
        ? error.details[0].message
        : 'Some fields need attention before this can be saved.'
    case 'bad_request':
      return error.message
    case 'server':
      return 'The server hit an unexpected problem. Nothing was saved.'
    default:
      return 'Something went wrong. Please try again.'
  }
}

/** True when the failure is a business-rule rejection rather than a fault —
 *  these belong inline next to the control, not in an error toast. */
export function isExpectedRejection(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === 'conflict' || error.kind === 'validation')
}
