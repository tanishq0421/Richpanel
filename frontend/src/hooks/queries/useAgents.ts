import { useMemo } from 'react'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { apiService } from '@/api/apiService'
import type { ApiError } from '@/api/http'
import type { AgentDTO } from '@/api/types'

/** The backend's own page cap (`PaginationParams.limit`, `le=200`). Fetching
 *  at that ceiling keeps a full-directory scroll to the fewest round trips. */
const PAGE_SIZE = 200

export interface UseAgentsResult {
  data: AgentDTO[] | undefined
  isLoading: boolean
  isSuccess: boolean
  isError: boolean
  error: ApiError | null
  refetch: () => void
  /** Fetch the next page of the directory (or of the current search's
   *  matches), appending onto `data`. A no-op while a fetch is already in
   *  flight or none remain -- callers do not need to check `hasNextPage`
   *  themselves before calling it. */
  fetchNextPage: () => void
  /** Whether another page might exist. Derived from "did the last page come
   *  back full" -- the endpoint returns no total count, so this is the only
   *  signal available, same as any other cursor-less paginated API. */
  hasNextPage: boolean
  isFetchingNextPage: boolean
}

/**
 * The agent directory: paginated, and server-side filtered by name when
 * `search` is non-empty. Cached per search term and reused by the
 * assignment picker, `useReportRows`, and the deletion-impact modal.
 *
 * A single fixed-size page cannot be the whole answer for an org with
 * thousands of agents -- raising the limit only moves the cliff. Callers
 * that never call `fetchNextPage` (the two id -> name lookups) simply see
 * the first `PAGE_SIZE` agents, exactly as before this was paginated; the
 * assignment picker is the one place that both searches and pages further.
 */
export function useAgents(search = ''): UseAgentsResult {
  const q = search.trim()
  const query = useInfiniteQuery<AgentDTO[], ApiError>({
    queryKey: ['agents', 'list', 'infinite', q] as const,
    queryFn: ({ pageParam }) => apiService.agents.list({ limit: PAGE_SIZE, offset: pageParam as number, q: q || undefined }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => (lastPage.length < PAGE_SIZE ? undefined : allPages.length * PAGE_SIZE),
    // `isLoading` must be the FIRST fetch only, same reasoning as
    // useAssignmentConflicts: every later search term is a NEW query key
    // (`q` changed), and without `keepPreviousData` each one would flip
    // `isLoading` back to true and disable the search box mid-typing --
    // disabling a browser `<input>` that has focus blurs it, which is what
    // was actually happening (verified live: typing into the search box lost
    // focus to the dialog root the moment a debounced search re-fetched).
    placeholderData: keepPreviousData,
  })

  // `.pages.flat()` must stay tied to `query.data`'s own identity rather than
  // being recomputed on every render: react-query already keeps `query.data`
  // referentially stable between renders when nothing changed, and consumers
  // downstream (`useReportRows`) depend on that stability to avoid
  // recomputing on every render themselves.
  const data = useMemo(() => query.data?.pages.flat(), [query.data])

  return {
    data,
    isLoading: query.isLoading,
    isSuccess: query.isSuccess,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
    fetchNextPage: () => void query.fetchNextPage(),
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  }
}
