/**
 * useConvertToWorktreeGate — everything the "Convert to worktree" row needs to
 * know about whether it may run.
 *
 * ── Why the two arms live together ──────────────────────────────────────────
 * Conversion is refused for two INDEPENDENT reasons, and they are composed here
 * rather than split between a hook and the JSX so a future third reason has one
 * obvious home:
 *
 *   1. BUSY — the tab has work in flight. Conversion relocates the tab, and
 *      relocation is `restartTabEntry` + `ensureSession`
 *      (main/engine-control-plane-relocate.ts); step 1 calls `stopSession`. So
 *      converting a running tab aborts its run, kills its dispatched background
 *      agents, and kills its background shells — the operator then has to
 *      re-enter the tab and ask the agent to resume. The engine pins a
 *      session's working directory at start_session, so the restart is inherent
 *      to relocation and cannot be engineered away; the verb has to be refused
 *      while the tab is busy instead. Evaluated with the same predicate that
 *      guards tab close (session-busy-guard.ts) plus the tab's own status,
 *      because the two verbs destroy the same work.
 *
 *   2. DIRTY — the base checkout has uncommitted changes. Converting would
 *      strand them in the repo while the conversation moves to the worktree.
 *
 * They answer different questions and neither subsumes the other: a running
 * agent that has not yet written a file leaves the checkout clean, so the
 * dirtiness probe alone would report the row as available while conversion was
 * still destructive.
 *
 * Busy is reported first. It is the more urgent reason, it needs no async
 * probe, and it is the one the operator can act on immediately (interrupt, or
 * wait for idle).
 *
 * ── Why this is a hook and not inline ───────────────────────────────────────
 * TabStripTabContextMenu.tsx sits near the 600-line cap. The dirtiness probe is
 * a ~45-line effect with its own cancellation bookkeeping; keeping it plus the
 * busy fold in the component would push the file over. Extracting also means
 * the row's JSX reads as three plain values.
 */
import { useState, useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { evaluateSessionBusyGuard } from '../stores/slices/session-busy-guard'
import type { TabState } from '../../shared/types'
import { rWarn } from '../rendererLogger'

export interface ConvertToWorktreeGate {
  /** Whether the row should render at all (a git repo, not already a worktree). */
  show: boolean
  /** Whether the row is present but refuses to run. */
  disabled: boolean
  /** Row label, carrying the refusal reason when there is one. */
  label: string
}

/**
 * Resolve the convert row's visibility, enablement, and label for `tab`.
 *
 * Reads `conversationPanes` through a store subscription so the busy arm is
 * reactive: a tab that goes idle while the menu is open enables the row without
 * the operator having to close and reopen it.
 */
export function useConvertToWorktreeGate(tab: TabState): ConvertToWorktreeGate {
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [uncommitted, setUncommitted] = useState<boolean | 'checking'>('checking')

  // Subscribed, not read via getState(): the fold below must re-run when an
  // instance's statusFields move, or the row would keep the enablement it had
  // at the moment the menu opened.
  const conversationPanes = useSessionStore((s) => s.conversationPanes)

  useEffect(() => {
    let cancelled = false
    if (!tab.workingDirectory || tab.worktree) {
      setIsGitRepo(false)
      return () => { cancelled = true }
    }

    setUncommitted('checking')
    void window.ion.gitIsRepo(tab.workingDirectory).then(({ isRepo }) => {
      if (cancelled) return
      setIsGitRepo(isRepo)
      if (!isRepo) {
        setUncommitted(false)
        return
      }
      return window.ion.gitChanges(tab.workingDirectory).then((result) => {
        if (!cancelled) setUncommitted(result.files.length > 0)
      }).catch((err) => {
        if (!cancelled) {
          rWarn('tab-context-menu', 'convert-to-worktree dirtiness probe failed; allowing conversion', {
            tab_id: tab.id,
            working_directory: tab.workingDirectory,
            error: String(err),
          })
          setUncommitted(false)
        }
      })
    }).catch((err) => {
      if (!cancelled) {
        rWarn('tab-context-menu', 'git repository probe failed; hiding convert-to-worktree action', {
          tab_id: tab.id,
          working_directory: tab.workingDirectory,
          error: String(err),
        })
        setIsGitRepo(false)
      }
    })

    return () => { cancelled = true }
  }, [tab.id, tab.workingDirectory, tab.worktree])

  // `tab.status` covers the orchestrator as the tab strip sees it; the guard
  // covers per-instance state, dispatched children, and background shells that
  // the tab-level status does not reflect. A tab can be idle at the tab level
  // and still have a sub-agent or a background build running.
  const busy =
    tab.status === 'running' ||
    tab.status === 'connecting' ||
    tab.bashExecuting ||
    evaluateSessionBusyGuard(conversationPanes.get(tab.id)).blocked

  const label = busy
    ? 'Convert to worktree (tab is busy)'
    : uncommitted === 'checking'
      ? 'Convert to worktree (checking...)'
      : uncommitted
        ? 'Convert to worktree (uncommitted changes)'
        : 'Convert to worktree'

  return {
    show: !tab.worktree && isGitRepo,
    disabled: busy || uncommitted !== false,
    label,
  }
}
