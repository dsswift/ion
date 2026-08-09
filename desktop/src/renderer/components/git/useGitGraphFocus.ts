import { useEffect, useMemo, useRef, useState } from 'react'
import { rDebug, rError, rInfo, rWarn } from '../../rendererLogger'
import type { GitCommit } from '../../../shared/types'
import type { GraphFilters } from './GraphFilterBar'

export interface GraphFocusRequest {
  key: string
  index: number
}

interface UseGitGraphFocusOptions {
  activeTabId: string
  directory: string
  branch: string
  headSha: string | null
  filters: GraphFilters
  commits: GitCommit[]
  totalCount: number
  graphLoaded: boolean
  loading: boolean
  loadNextPage: () => Promise<void>
}

/**
 * Finds active checkout's HEAD in paged graph results and issues one focus
 * request per conversation/HEAD/filter identity. Normal graph refreshes leave
 * completed requests untouched, preserving intentional manual scroll position.
 */
export function useGitGraphFocus({
  activeTabId,
  directory,
  branch,
  headSha,
  filters,
  commits,
  totalCount,
  graphLoaded,
  loading,
  loadNextPage,
}: UseGitGraphFocusOptions): GraphFocusRequest | null {
  const filtersKey = useMemo(() => JSON.stringify(filters), [filters])
  const targetKey = useMemo(() => {
    if (!headSha) return null
    return JSON.stringify({ activeTabId, directory, headSha, filters: filtersKey })
  }, [activeTabId, directory, filtersKey, headSha])
  const [focusRequest, setFocusRequest] = useState<GraphFocusRequest | null>(null)
  const requestedTargetRef = useRef<string | null>(null)
  const completedTargetRef = useRef<string | null>(null)
  const unavailableTargetRef = useRef<string | null>(null)
  const loadingTargetRef = useRef<string | null>(null)

  useEffect(() => {
    if (!targetKey || !headSha) {
      requestedTargetRef.current = null
      completedTargetRef.current = null
      unavailableTargetRef.current = null
      loadingTargetRef.current = null
      setFocusRequest(null)
      return
    }
    if (requestedTargetRef.current === targetKey) return

    requestedTargetRef.current = targetKey
    completedTargetRef.current = null
    unavailableTargetRef.current = null
    loadingTargetRef.current = null
    setFocusRequest(null)
    rInfo('git.graph.focus', 'focus requested for checked-out commit', {
      directory,
      active_tab_id: activeTabId,
      branch,
      head_sha: headSha,
    })
  }, [activeTabId, branch, directory, headSha, targetKey])

  useEffect(() => {
    if (!targetKey || !headSha || !graphLoaded || loading) return
    if (requestedTargetRef.current !== targetKey) return
    if (completedTargetRef.current === targetKey || unavailableTargetRef.current === targetKey) return

    const index = commits.findIndex((commit) => commit.fullHash === headSha)
    if (index >= 0) {
      completedTargetRef.current = targetKey
      setFocusRequest({ key: targetKey, index })
      rInfo('git.graph.focus', 'checked-out commit found in graph', {
        directory,
        active_tab_id: activeTabId,
        branch,
        head_sha: headSha,
        index,
        loaded_count: commits.length,
        total_count: totalCount,
      })
      return
    }

    if (commits.length < totalCount) {
      if (loadingTargetRef.current === targetKey) return
      loadingTargetRef.current = targetKey
      rDebug('git.graph.focus', 'loading next graph page for checked-out commit', {
        directory,
        active_tab_id: activeTabId,
        branch,
        head_sha: headSha,
        loaded_count: commits.length,
        total_count: totalCount,
      })
      void loadNextPage()
        .catch((error) => {
          rError('git.graph.focus', 'loading graph page for checked-out commit failed', {
            directory,
            active_tab_id: activeTabId,
            branch,
            head_sha: headSha,
            error: String(error),
          })
        })
        .finally(() => {
          if (loadingTargetRef.current === targetKey) loadingTargetRef.current = null
        })
      return
    }

    unavailableTargetRef.current = targetKey
    rWarn('git.graph.focus', 'checked-out commit unavailable in graph', {
      directory,
      active_tab_id: activeTabId,
      branch,
      head_sha: headSha,
      loaded_count: commits.length,
      total_count: totalCount,
    })
  }, [activeTabId, branch, commits, directory, graphLoaded, headSha, loadNextPage, loading, targetKey, totalCount])

  return focusRequest
}
