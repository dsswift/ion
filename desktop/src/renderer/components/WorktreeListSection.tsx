/**
 * WorktreeListSection — every worktree in this repo, once, with its bench
 * membership shown as row state.
 *
 * ── Why one list ────────────────────────────────────────────────────────────
 * This replaces two sections that described the same object. `WorktreesSection`
 * listed worktrees; `IntegrationSection` listed bench members -- but a member IS
 * a worktree, so an enrolled one rendered twice in one 320px panel, in two
 * components with two vocabularies (`stale` vs `needsSync`, `conflicted` vs
 * `operationState`) for facts a reader had to reconcile by hand. Two panes also
 * spent two section headers and two minimum-body floors on one concept.
 *
 * Enrollment is now a control in the row's gutter, and enrolled rows sort to the
 * top under the bench bar, connected by a rail that numbers them in merge order.
 * The bench is visible AS an ordered stack of worktrees, which is what it is.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { singleFlight } from '../utils/single-flight'
import { Plus } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { WorktreeRow } from './WorktreeRow'
import { BenchBar } from './BenchBar'
import { ConflictsDialog } from './git/ConflictsDialog'
import { BenchConflictDialog } from './git/BenchConflictDialog'
import { ConfirmDialog } from './git/ConfirmDialog'
import { WorktreeRowMenu } from './WorktreeRowMenu'
import { rError } from '../rendererLogger'
import { collectDirConversations, pickBenchConversation, pickDirTerminal, benchTerminalTitle } from '../../shared/worktree-conversations'
import { buildWorktreeList } from '../../shared/worktree-list'
import { getGroupStatusColor } from './TabStripShared'
import { useBenchReorder } from '../hooks/useBenchReorder'
import type { WorktreeInventoryEntry, IntegrationMember } from '../../shared/types'

/** Stable empty map so the selector does not return a fresh object per render. */
const EMPTY_RETIRED: ReadonlyMap<string, IntegrationMember[]> = new Map()

export function WorktreeListSection({
  repoPath,
  refreshKey,
  inBenchFor,
}: {
  repoPath: string
  refreshKey: number
  /**
   * Source branch of the bench this panel is looking AT, when it is inside one.
   *
   * Selects which bench decorates the rows, so a conversation in a bench sees
   * that bench's memberships and merge order rather than whichever workspace
   * happened to be first. With one bench per repo the two agree; with several
   * they did not, and the same worktree list reordered itself depending on where
   * you opened the panel from.
   */
  inBenchFor?: string
}): React.JSX.Element {
  const colors = useColors()
  const inventory = useSessionStore((s) => s.worktreeInventory.get(repoPath))
  const workspaces = useSessionStore((s) => s.benchWorkspaces.get(repoPath))
  const tips = useSessionStore((s) => s.benchSourceTips.get(repoPath))
  const retired = useSessionStore((s) => s.benchRetired.get(repoPath)) ?? EMPTY_RETIRED
  const tabs = useSessionStore((s) => s.tabs)

  const [syncing, setSyncing] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ entry: WorktreeInventoryEntry; anchor: { x: number; y: number } } | null>(null)
  const [resolving, setResolving] = useState<string | null>(null)
  /**
   * The conflicted membership whose bench-conflict dialog is open. Distinct
   * from `resolving` (the ConflictsDialog on a directory with a REAL
   * in-progress operation): a bench conflict has no operation on disk — the
   * failed assembly aborted its merge and wiped the bench — so its dialog
   * reads the membership record. The badge used to open the ConflictsDialog on
   * the bench path, which probed for an operation that could not exist and
   * rendered an empty list with a dead Abort.
   */
  const [benchConflict, setBenchConflict] = useState<{ member: IntegrationMember; sourceBranch: string } | null>(null)
  const [selectedBench, setSelectedBench] = useState<string | null>(null)
  const [discardCount, setDiscardCount] = useState<number | null>(null)

  // One refresh in flight at a time (see singleFlight). Without this, a tick
  // that fires while the previous fetch is still running queues another full
  // crawl behind it — under load that compounds every 5s and is exactly how
  // overlapping inventory crawls once piled up until the main process froze
  // (the main-process service coalesces too; this stops the redundant IPC at
  // the source). A trigger that lands mid-flight is dropped, not deferred:
  // the next interval tick re-reads at most 5s later, the same staleness
  // bound the poll already accepts.
  const refresh = useMemo(() => singleFlight(() => {
    const store = useSessionStore.getState()
    // allSettled: both refresh actions log their own failures; the flight
    // must settle no matter how they end, or the panel never refreshes again.
    return Promise.allSettled([
      store.refreshWorktreeInventory(repoPath),
      store.refreshBench(repoPath),
    ])
  }), [repoPath])

  // Refresh on mount, on directory change, and whenever the panel's git state
  // moves (a land, commit, or branch change alters pins and staleness).
  // View-readiness: the list must be correct the moment it renders.
  useEffect(() => { refresh() }, [refresh, refreshKey])

  // Poll while the section is open. The rows describe git state that moves
  // OUTSIDE this window — an agent committing in a worktree, a land from
  // another conversation — and none of those paths bump `refreshKey`, so
  // without a poll the dirty dots and unlanded counts sit stale until the
  // operator happens to touch the panel. Both refresh actions are read-only
  // IPC fetches into a derived cache (mirror-local by classification), so the
  // poll is safe to run per-window. Skipped while the document is hidden:
  // a backgrounded window re-syncs on the next visible tick instead of
  // scanning git forever for nobody.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      refresh()
    }, 5000)
    return () => window.clearInterval(id)
  }, [refresh])

  const benches = useMemo(() => workspaces ?? [], [workspaces])
  // Default to the first bench; the selector in the bar switches it.
  // Explicit selection wins, then the bench we are standing in, then the first.
  const active = useMemo(
    () => benches.find((w) => w.sourceBranch === selectedBench)
      ?? benches.find((w) => w.sourceBranch === inBenchFor)
      ?? benches[0],
    [benches, selectedBench, inBenchFor],
  )

  // ONE function decides list order, shared with the ATV mirror and the wire
  // projection, so no surface can sort these differently.
  const { items, orphans } = useMemo(
    () => buildWorktreeList(inventory ?? [], benches, active?.sourceBranch ?? null),
    [inventory, benches, active],
  )

  const enrolledCount = items.filter((i) => i.order !== undefined).length
  const behindCount = items.filter((i) => i.membership?.pin === 'behind').length

  // The bench's singleton operator conversation, resolved the same way the
  // remote projection resolves it: only a ROLE-TAGGED tab counts as open.
  // An adoptable legacy candidate is deliberately not "open" — adoption is a
  // decision the store makes at open time, so treating it as open here would
  // label the button "Go to" for a tab the next press might not choose.
  // `benchPath ?? ''` is safe: pickBenchConversation returns null on an empty
  // path, which is also the correct answer when no bench is selected.
  const benchConversationFound = pickBenchConversation(tabs, active?.benchPath ?? '')
  const benchConversationOpen = !!benchConversationFound && !benchConversationFound.adopted

  /**
   * Aggregate conversation status for one worktree, or undefined when nothing
   * is open there.
   *
   * Undefined is meaningfully different from an idle dot: "no conversations"
   * and "conversations, all idle" are different facts, and the row renders a
   * hollow ring for the first rather than a filled grey one.
   *
   * Terminal-only tabs are filtered out BEFORE the emptiness check, for the
   * same reason `collectDirConversations` skips them: a terminal is not a
   * conversation. `getGroupStatusColor` already ignores them internally, so a
   * directory holding only a terminal used to produce a non-empty array that
   * folded to the idle colour -- rendering "nothing open here" as "open, all
   * idle", which the row's tooltip then said in words.
   */
  const activityFor = useCallback((worktreePath: string) => {
    const inWorktree = tabs.filter((t) => t.workingDirectory === worktreePath && !t.isTerminalOnly)
    if (inWorktree.length === 0) return undefined
    return getGroupStatusColor(inWorktree, colors)
  }, [tabs, colors])

  const run = useCallback((key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    void fn()
      // Static msg with the operation as a FIELD (ADR-019): an interpolated
      // message is unqueryable in the log store.
      .catch((err) => rError('worktree.list', 'bench operation failed', { operation: key, error: String(err) }))
      .finally(() => { setBusy(null); refresh() })
  }, [refresh])

  /**
   * Drag-reorder for the enrolled group.
   *
   * The gesture lives here rather than in the row because ORDER is a property of
   * the list: the row knows its own index but not the group's bounds, and the
   * clamp that stops a drag from leaving the bench needs both.
   */
  const reorder = useBenchReorder({
    enrolledCount,
    onReorder: (fromIndex, toIndex) => {
      const moved = items[fromIndex]
      const branch = moved?.membership ? active?.sourceBranch : undefined
      if (!moved || !branch) return
      run(moved.entry.worktreePath, async () => {
        await useSessionStore.getState()
          .benchSetOrder(repoPath, branch, moved.entry.worktreePath, toIndex)
      })
    },
  })

  const handleSync = useCallback((entry: WorktreeInventoryEntry) => {
    if (!entry.sourceBranch) return
    setSyncing(entry.worktreePath)
    void useSessionStore.getState()
      .syncWorktree(entry.worktreePath, entry.sourceBranch, repoPath)
      .catch((err) => rError('worktree.list', 'sync failed', { error: String(err) }))
      .finally(() => setSyncing(null))
  }, [repoPath])

  /**
   * Enroll or unenroll. The bench a worktree joins is fully determined by its
   * source branch, so there is nothing to choose -- and `benchAddMember`
   * creates the workspace record on first enrollment, which commits the
   * operator to nothing (the directory is materialised by the first rebuild).
   */
  const toggleEnrollment = useCallback((entry: WorktreeInventoryEntry, enrolled: boolean) => {
    const branch = enrolled ? active?.sourceBranch : entry.sourceBranch
    if (!branch) return
    run(entry.worktreePath, async () => {
      const store = useSessionStore.getState()
      if (enrolled) await store.benchRemoveMember(repoPath, branch, entry.worktreePath)
      else await store.benchAddMember(repoPath, branch, entry.worktreePath, entry.branchName)
    })
  }, [active, repoPath, run])

  return (
    // `flex: 1` so the scroll viewport is the pane body rather than the content
    // height, and `overflowX: hidden` so no row can reintroduce sideways scroll.
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflowX: 'hidden', overflowY: 'auto' }}>
      {active && (
        <BenchBar
          workspaces={benches}
          active={active}
          benchConversations={collectDirConversations(tabs, active.benchPath)}
          baseDrifted={!!tips?.[active.sourceBranch] && tips[active.sourceBranch] !== active.baseSha}
          orphans={orphans}
          absorbed={retired.get(active.sourceBranch) ?? []}
          behindCount={behindCount}
          benchTerminalOpen={
            !!pickDirTerminal(tabs, active.benchPath, benchTerminalTitle(active.sourceBranch))
          }
          benchConversationOpen={benchConversationOpen}
          busy={busy}
          onSelectWorkspace={setSelectedBench}
          onOpenTerminal={() => run('terminal', async () => {
            await useSessionStore.getState().openBenchTerminal(repoPath, active.sourceBranch)
          })}
          onOpenConversation={() => run('conversation', async () => {
            await useSessionStore.getState().openBenchConversation(repoPath, active.sourceBranch)
          })}
          onAssemble={() => run('assemble', async () => {
            const store = useSessionStore.getState()
            // Update-all when something is behind, plain assembly otherwise.
            // Assembly alone never advances a pin, so it is always safe.
            await (behindCount > 0
              ? store.benchUpdateAll(repoPath, active.sourceBranch)
              : store.benchAssemble(repoPath, active.sourceBranch))
          })}
          onDiscardRecordings={() => {
            void useSessionStore.getState().benchRerereCount(active.benchPath)
              .then(setDiscardCount)
              .catch((err) => rError('worktree.list', 'recording count failed', { error: String(err) }))
          }}
          onDismissAbsorbed={() => useSessionStore.getState().clearBenchRetired(repoPath, active.sourceBranch)}
        />
      )}

      {items.length === 0 ? (
        <div style={{ padding: '6px 8px', fontSize: 10, color: colors.textTertiary }}>
          No worktrees for this project.
        </div>
      ) : (
        items.map((item, i) => {
          const entry = item.entry
          const enrolled = item.order !== undefined
          // The landed band opens with a heading, so completed work reads as a
          // deliberate section rather than rows that happen to sit last.
          const startsLandedGroup = item.landed && !items[i - 1]?.landed
          const benchBranch = item.membership ? active?.sourceBranch : undefined
          return (
            <React.Fragment key={entry.worktreePath}>
              {startsLandedGroup && (
                <div
                  data-testid="worktree-landed-heading"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '6px 6px 2px', fontSize: 9, flexShrink: 0,
                    color: colors.textTertiary,
                  }}
                >
                  <span style={{ flexShrink: 0 }}>
                    Landed · {items.filter((it) => it.landed).length}
                  </span>
                  <span style={{ flex: 1, height: 1, background: colors.containerBorder }} />
                </div>
              )}
            <WorktreeRow
              entry={entry}
              openConversations={collectDirConversations(tabs, entry.worktreePath)}
              // The SAME fold the tab-group pills use, over the tabs living in
              // this worktree. Reused rather than reimplemented so a worktree
              // row and a group pill can never disagree about what "running"
              // looks like.
              activity={activityFor(entry.worktreePath)}
              membership={item.membership}
              order={item.order}
              // The rail connects consecutive enrolled rows. Enrolled rows sort
              // first, so "previous is enrolled" is simply i > 0 within the
              // enrolled run.
              railStarts={enrolled && i > 0}
              railContinues={enrolled && i + 1 < enrolledCount}
              syncing={syncing === entry.worktreePath}
              onOpen={() => {
                void useSessionStore.getState()
                  .openWorktreeConversation(entry.worktreePath)
                  .catch((err) => rError('worktree.list', 'open conversation failed', { error: String(err) }))
              }}
              onSync={() => handleSync(entry)}
              onMenu={(anchor) => setMenu({ entry, anchor })}
              onResolve={() => setResolving(entry.worktreePath)}
              onToggleEnrollment={() => toggleEnrollment(entry, enrolled)}
              onToggleIncluded={() => {
                if (!benchBranch || !item.membership) return
                run(entry.worktreePath, async () => {
                  await useSessionStore.getState().benchSetEnabled(
                    repoPath, benchBranch, entry.worktreePath, !item.membership!.enabled)
                })
              }}
              onUpdatePin={() => {
                if (!benchBranch) return
                run(entry.worktreePath, async () => {
                  await useSessionStore.getState().benchUpdateMember(repoPath, benchBranch, entry.worktreePath)
                })
              }}
              onShowBenchConflict={() => {
                // The membership record IS the read model; there is no
                // in-progress operation on disk to probe (see the state doc).
                if (item.membership && active) {
                  setBenchConflict({ member: item.membership, sourceBranch: active.sourceBranch })
                }
              }}
              onSetReview={benchBranch ? (review) => {
                run(entry.worktreePath, async () => {
                  await useSessionStore.getState()
                    .benchSetReview(repoPath, benchBranch, entry.worktreePath, review)
                })
              } : undefined}
              dragHandlers={reorder.rowHandlers(i, enrolled)}
              dragging={reorder.draggingIndex === i}
              dropTarget={reorder.overIndex === i}
            />
            </React.Fragment>
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
            .catch((err) => rError('worktree.list', 'create worktree failed', { error: String(err) }))
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '4px 6px', margin: '2px 0 0',
          background: 'transparent', border: 'none',
          color: colors.textSecondary, fontSize: 10, cursor: 'pointer', textAlign: 'left',
          // Never squeezed by a long list: the section grows, so an unpinned
          // button is the first thing a full list compresses.
          flexShrink: 0,
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.surfaceHover }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <Plus size={10} />
        <span>New worktree</span>
      </button>

      {discardCount !== null && active && (
        <ConfirmDialog
          title="Discard recorded resolutions?"
          message={discardCount === 0
            ? 'No recorded conflict resolutions exist.'
            : `Discard ${discardCount} recorded conflict resolution${discardCount === 1 ? '' : 's'}? Future conflicts must be resolved again.`}
          confirmLabel={discardCount === 0 ? 'Close' : `Discard ${discardCount}`}
          danger={discardCount > 0}
          onCancel={() => setDiscardCount(null)}
          onConfirm={() => {
            if (discardCount === 0) { setDiscardCount(null); return }
            run('discard-recordings', async () => {
              await useSessionStore.getState().benchRerereDiscardAll(active.benchPath)
              setDiscardCount(null)
            })
          }}
        />
      )}

      {resolving && (
        <ConflictsDialog
          directory={resolving}
          onClose={() => {
            setResolving(null)
            // When the dialog was driving the bench's resolve-once merge, the
            // bench must be reassembled on the way out — after Continue the
            // recording replays and the assembly completes; after Abort the
            // reassembly restores the honest wiped-failed state. Both
            // converge, so the reassembly is unconditional for a bench.
            if (active && resolving === active.benchPath) {
              run('assemble', async () => {
                await useSessionStore.getState().benchAssemble(repoPath, active.sourceBranch)
              })
            } else {
              refresh()
            }
          }}
        />
      )}

      {benchConflict && active && (
        <BenchConflictDialog
          repoPath={repoPath}
          sourceBranch={benchConflict.sourceBranch}
          member={benchConflict.member}
          onClose={() => { setBenchConflict(null); refresh() }}
          onResolveReady={(benchPath) => {
            // The store prepared a REAL in-progress merge in the bench, so the
            // ConflictsDialog now has an operation to drive. Swap dialogs.
            setBenchConflict(null)
            setResolving(benchPath)
          }}
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
