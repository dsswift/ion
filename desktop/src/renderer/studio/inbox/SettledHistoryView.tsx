/**
 * SettledHistoryView — full-page settled history replacing the inbox content.
 *
 * Shows settled conversations within the 90-day history window with metadata search,
 * pagination, and lazy conversation loading on row selection. The view
 * occupies the same space as the inbox list when activated via the overflow
 * affordance in the settled shelf.
 */
import React, { useCallback, useMemo, useState } from 'react'
import { ArrowLeft, MagnifyingGlass } from '@phosphor-icons/react'
import { useSessionStore } from '../../stores/sessionStore'
import { useColors } from '../../theme'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'
import { formatRelativeShort } from '../../components/TabStripShared'
import { inboxProjectFor, inboxWorktreeFor } from './inbox-grouping'
import { searchSettledTabs, paginateSettled } from './settled-history'
import { settledRecordRestorableFromInventory } from '../../stores/settled-worktree'
import type { TabState, IntegrationWorkspace } from '../../../shared/types'

/* ------------------------------------------------------------------ */
/*  Row                                                               */
/* ------------------------------------------------------------------ */

function HistoryRow({ tab, projectName, worktreeTitle, isActive, onSelect }: {
  tab: TabState
  projectName: string
  worktreeTitle: string | null
  isActive: boolean
  onSelect: () => void
}): React.JSX.Element {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  const title = tab.customTitle || tab.title || 'Untitled'
  const age = tab.settledAt != null ? formatRelativeShort(tab.settledAt) : ''

  return (
    <button
      {...handlers}
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', padding: '6px 10px', border: 'none', borderRadius: 6,
        background: interactiveBg(colors, { hover, pressed }, isActive ? colors.accentLight : 'transparent'),
        color: colors.textPrimary, cursor: 'pointer', textAlign: 'left',
        transition: `background ${transitions.base}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          display: 'block', fontSize: 11, fontWeight: isActive ? 600 : 400,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title}</span>
        <span style={{
          display: 'block', marginTop: 1, fontSize: 10,
          color: colors.textTertiary, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{projectName}{worktreeTitle ? ` · ${worktreeTitle}` : ''}</span>
        {tab.settledOverride === 'auto' && <span style={{ display: 'block', marginTop: 1, fontSize: 9, color: colors.textTertiary }}>Auto</span>}
      </div>
      {age && <span style={{ flexShrink: 0, fontSize: 9, color: colors.textTertiary }}>{age}</span>}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/*  Pagination bar                                                    */
/* ------------------------------------------------------------------ */

function PageBar({ page, totalPages, hasMore, onPage }: {
  page: number
  totalPages: number
  hasMore: boolean
  onPage: (page: number) => void
}): React.JSX.Element | null {
  const colors = useColors()
  if (totalPages <= 1) return null

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: 10, padding: '6px 10px', fontSize: 10, color: colors.textTertiary,
    }}>
      <button
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
        style={{
          border: 'none', background: 'transparent', cursor: page === 0 ? 'default' : 'pointer',
          color: page === 0 ? colors.textTertiary : colors.accent, fontSize: 10, opacity: page === 0 ? 0.4 : 1,
        }}
      >Prev</button>
      <span>{page + 1} / {totalPages}</span>
      <button
        disabled={!hasMore}
        onClick={() => onPage(page + 1)}
        style={{
          border: 'none', background: 'transparent', cursor: !hasMore ? 'default' : 'pointer',
          color: !hasMore ? colors.textTertiary : colors.accent, fontSize: 10, opacity: !hasMore ? 0.4 : 1,
        }}
      >Next</button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main view                                                         */
/* ------------------------------------------------------------------ */

export function SettledHistoryView({ history, onBack }: {
  /** All settled tabs older than 30 days (pre-partitioned). */
  history: TabState[]
  onBack: () => void
}): React.JSX.Element {
  const colors = useColors()
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const benches: ReadonlyMap<string, readonly IntegrationWorkspace[]> = useSessionStore((s) => s.benchWorkspaces)
  const inventory = useSessionStore((s) => s.worktreeInventory)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)

  const filtered = useMemo(
    () => searchSettledTabs(history, query.trim(), benches, inventory),
    [history, query, benches, inventory],
  )

  const paginated = useMemo(() => paginateSettled(filtered, page), [filtered, page])

  /** Reset to first page when the search changes. */
  const updateQuery = useCallback((next: string) => {
    setQuery(next)
    setPage(0)
  }, [])

  /** Open a cold history record for review without activating its engine session. */
  const selectRow = useCallback((tab: TabState) => {
    const state = useSessionStore.getState()
    if (!state.tabs.some((candidate) => candidate.id === tab.id)) void state.restoreSettledHistoryTab(tab.id)
    else state.selectTab(tab.id)
  }, [])

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 10px', borderBottom: `1px solid ${colors.containerBorder}`,
      }}>
        <button
          onClick={onBack}
          aria-label="Back to inbox"
          style={{
            display: 'flex', border: 'none', background: 'transparent',
            color: colors.textSecondary, cursor: 'pointer', padding: 0,
          }}
        ><ArrowLeft size={16} /></button>
        <span style={{ fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>
          Settled History
        </span>
        <span style={{ fontSize: 10, color: colors.textTertiary }}>
          {filtered.length} conversation{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Search */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 10px', borderBottom: `1px solid ${colors.containerBorder}`,
      }}>
        <MagnifyingGlass size={12} color={colors.textTertiary} />
        <input
          value={query}
          onChange={(e) => updateQuery(e.target.value)}
          placeholder={`Search ${history.length} settled conversations`}
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, fontSize: 11, border: 'none', outline: 'none',
            background: 'transparent', color: colors.textPrimary,
          }}
        />
      </div>

      {/* List */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 4 }}>
        {paginated.page.length === 0 ? (
          <div style={{ padding: 12, fontSize: 11, color: colors.textTertiary }}>
            {query.trim() ? 'No matching conversations.' : 'No settled history.'}
          </div>
        ) : paginated.page.map((tab) => (
          <HistoryRow
            key={tab.id}
            tab={tab}
            projectName={inboxProjectFor(tab, benches).name}
            worktreeTitle={tab.worktree ? inboxWorktreeFor(tab, benches, inventory).label : null}
            isActive={tab.id === activeTabId}
            onSelect={() => { if (settledRecordRestorableFromInventory(tab, inventory)) selectRow(tab) }}
          />
        ))}
      </div>

      {/* Pagination */}
      <PageBar
        page={page}
        totalPages={paginated.totalPages}
        hasMore={paginated.hasMore}
        onPage={setPage}
      />
    </div>
  )
}
