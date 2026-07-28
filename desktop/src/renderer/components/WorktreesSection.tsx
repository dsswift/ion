/**
 * WorktreesSection — the git panel's answer to "what worktrees exist here, and
 * how do I get back into one?".
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Closing a worktree conversation no longer destroys the worktree, which makes
 * close safe — but the conversation is still gone, and there is no history
 * feature to recover it. Before this, the only way back in was to create a tab
 * and manually browse to a generated path like `~/.ion/worktrees/ion-a3f1` that
 * the operator has no reason to know.
 *
 * Listing worktrees with their state is strictly better than forbidding close,
 * which would pin the operator to one immortal conversation per worktree.
 *
 * The section lives in the git panel because the panel is already per-project,
 * already open during git work, and has room for per-row state. The new-tab
 * picker carries the same rows for the zero-knowledge recovery case, where the
 * panel may not be open at all.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Plus } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { WorktreeRow } from './WorktreeRow'
import { ConflictsDialog } from './git/ConflictsDialog'
import { WorktreeRowMenu } from './WorktreeRowMenu'
import { rError } from '../rendererLogger'
import type { WorktreeInventoryEntry } from '../../shared/types'

export function WorktreesSection({
  repoPath,
  refreshKey,
}: {
  repoPath: string
  refreshKey: number
}): React.JSX.Element {
  const colors = useColors()
  const inventory = useSessionStore((s) => s.worktreeInventory.get(repoPath))
  const tabs = useSessionStore((s) => s.tabs)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ entry: WorktreeInventoryEntry; anchor: { x: number; y: number } } | null>(null)
  const [resolving, setResolving] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void useSessionStore.getState().refreshWorktreeInventory(repoPath)
  }, [repoPath])

  // Refresh on mount, on directory change, and whenever the panel's git state
  // moves (a land, commit, or branch change alters unlanded counts and
  // staleness). View-readiness: the list must be correct the moment it renders,
  // not a beat later.
  useEffect(() => { refresh() }, [refresh, refreshKey])

  const entries = inventory ?? []

  const handleSync = useCallback((entry: WorktreeInventoryEntry) => {
    if (!entry.sourceBranch) return
    setSyncing(entry.worktreePath)
    void useSessionStore.getState()
      .syncWorktree(entry.worktreePath, entry.sourceBranch, repoPath)
      .catch((err) => rError('worktree.section', 'sync failed', { error: String(err) }))
      .finally(() => setSyncing(null))
  }, [repoPath])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
      {entries.length === 0 ? (
        <div style={{ padding: '6px 8px', fontSize: 10, color: colors.textTertiary }}>
          No worktrees for this project.
        </div>
      ) : (
        entries.map((entry) => {
          const openIdx = tabs.findIndex((t) => t.workingDirectory === entry.worktreePath)
          return (
            <WorktreeRow
              key={entry.worktreePath}
              entry={entry}
              openTabId={openIdx >= 0 ? tabs[openIdx].id : undefined}
              openTabIndex={openIdx >= 0 ? openIdx + 1 : undefined}
              syncing={syncing === entry.worktreePath}
              onOpen={() => {
                void useSessionStore.getState()
                  .openWorktreeConversation(entry.worktreePath)
                  .catch((err) => rError('worktree.section', 'open conversation failed', { error: String(err) }))
              }}
              onSync={() => handleSync(entry)}
              onMenu={(anchor) => setMenu({ entry, anchor })}
              onResolve={() => setResolving(entry.worktreePath)}
            />
          )
        })
      )}

      <button
        data-testid="worktree-new"
        onClick={() => {
          // Reuses the existing worktree-creation path (branch picker included),
          // so there is one way a worktree comes into being.
          void useSessionStore.getState()
            .createTabInDirectory(repoPath, true, true)
            .then(() => refresh())
            .catch((err) => rError('worktree.section', 'create worktree failed', { error: String(err) }))
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '4px 6px', margin: '2px 0 0',
          background: 'transparent', border: 'none',
          color: colors.textSecondary, fontSize: 10, cursor: 'pointer', textAlign: 'left',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.surfaceHover }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <Plus size={10} />
        <span>New worktree</span>
      </button>

      {resolving && (
        <ConflictsDialog
          directory={resolving}
          onClose={() => { setResolving(null); refresh() }}
        />
      )}

      {menu && (
        <WorktreeRowMenu
          entry={menu.entry}
          anchor={menu.anchor}
          repoPath={repoPath}
          onClose={() => setMenu(null)}
          onRefresh={refresh}
        />
      )}
    </div>
  )
}
