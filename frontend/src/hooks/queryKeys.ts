import type { PaginationParams } from '@/api/types'

/**
 * Every cache key in one factory. Hand-written key arrays scattered across
 * hooks are how invalidation silently stops working — a mutation invalidates
 * `['schedules']` while a query registered `['schedule-list']` and never
 * refetches.
 */
export const queryKeys = {
  agents: {
    all: ['agents'] as const,
    list: (params: PaginationParams = {}) => ['agents', 'list', params] as const,
    schedules: (agentId: number) => ['agents', agentId, 'schedules'] as const,
  },
  schedules: {
    all: ['schedules'] as const,
    list: (params: PaginationParams = {}) => ['schedules', 'list', params] as const,
    detail: (id: number) => ['schedules', 'detail', id] as const,
    assignees: (id: number) => ['schedules', id, 'assignees'] as const,
    deletionImpact: (id: number) => ['schedules', id, 'deletion-impact'] as const,
    /** Prefix over every conflict pre-check for this schedule, whatever agent
     *  set was asked about. Freeing an agent from *another* schedule falsifies
     *  all of them, and it cannot know which set the picker last asked for. */
    assignmentChecks: (id: number) => ['schedules', id, 'assignment-check'] as const,
    assignmentCheck: (id: number, agentIds: number[]) =>
      ['schedules', id, 'assignment-check', agentIds] as const,
  },
  reports: {
    all: ['reports'] as const,
    list: (params: PaginationParams = {}) => ['reports', 'list', params] as const,
    detail: (id: number) => ['reports', 'detail', id] as const,
  },
} as const
