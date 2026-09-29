/**
 * Workspace Search state — the sidebar Search view's query, options, last
 * result, and which file groups are collapsed.
 *
 * Window-local and memory-only: switching the sidebar to another view and
 * back keeps the search, a relaunch starts empty. A response is applied only
 * when it answers the latest request, so a slow early search can never
 * replace a newer one.
 */
import { create } from 'zustand'
import type { TextSearchResult } from '@ion/shared/text-search'
import { host } from '../../host/host-instance'
import { rDebug, rWarn } from '../../rendererLogger'

export type WorkspaceSearchStatus = 'idle' | 'searching' | 'done'

interface WorkspaceSearchState {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  status: WorkspaceSearchStatus
  result: TextSearchResult | null
  /** Absolute paths of file groups the operator folded. */
  collapsed: ReadonlySet<string>
  /** Bumped by the shortcut; the panel focuses its input when this moves. */
  focusRequest: number

  setQuery(query: string): void
  toggleCaseSensitive(): void
  toggleWholeWord(): void
  toggleCollapsed(path: string): void
  /** Fold every file group (true) or open them all (false). */
  setAllCollapsed(collapsed: boolean): void
  requestFocus(): void
  run(roots: readonly string[]): Promise<void>
}

let latestRequest = 0

export const useWorkspaceSearchStore = create<WorkspaceSearchState>((set, get) => ({
  query: '',
  caseSensitive: false,
  wholeWord: false,
  status: 'idle',
  result: null,
  collapsed: new Set(),
  focusRequest: 0,

  setQuery: (query) => set({ query }),
  toggleCaseSensitive: () => set((s) => ({ caseSensitive: !s.caseSensitive })),
  toggleWholeWord: () => set((s) => ({ wholeWord: !s.wholeWord })),
  toggleCollapsed: (path) => set((s) => {
    const next = new Set(s.collapsed)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return { collapsed: next }
  }),
  setAllCollapsed: (collapsed) => set((s) => ({
    collapsed: collapsed ? new Set(s.result?.files.map((f) => f.path) ?? []) : new Set(),
  })),
  requestFocus: () => set((s) => ({ focusRequest: s.focusRequest + 1 })),

  run: async (roots) => {
    const { query, caseSensitive, wholeWord } = get()
    const request = ++latestRequest
    if (query.length === 0 || roots.length === 0) {
      set({ status: 'idle', result: null, collapsed: new Set() })
      return
    }
    set({ status: 'searching' })
    const started = Date.now()
    try {
      const result = await host.shell.searchText({ roots: [...roots], query, caseSensitive, wholeWord })
      if (request !== latestRequest) {
        rDebug('workspace-search', 'dropped a superseded search response', { request, latest: latestRequest })
        return
      }
      set({ status: 'done', result, collapsed: new Set() })
      if (result.error) rWarn('workspace-search', 'search returned an error', { roots: roots.length, error: result.error })
      rDebug('workspace-search', 'search answered', {
        roots: roots.length,
        query_length: query.length,
        files: result.files.length,
        matches: result.totalMatches,
        truncated: result.truncated,
        duration_ms: Date.now() - started,
      })
    } catch (err) {
      if (request !== latestRequest) return
      rWarn('workspace-search', 'search failed', { roots: roots.length, error: String(err) })
      set({ status: 'done', result: { files: [], totalMatches: 0, truncated: false, error: String(err) }, collapsed: new Set() })
    }
  },
}))
