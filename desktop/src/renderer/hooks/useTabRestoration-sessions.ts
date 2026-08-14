/**
 * Eager durable session start for restored conversations.
 *
 * Extracted from `useTabRestoration.ts` to keep it under the 600-line cap. The
 * seam is a real phase boundary: tab state is fully hydrated before this runs,
 * and this loop's only job is to bring each restored conversation's engine
 * session up.
 *
 * ── Why the start is staggered ──────────────────────────────────────────────
 * The active tab starts first (it is what the user is looking at), then the rest
 * start sequentially. A simultaneous burst overwhelms the shared engine daemon's
 * dispatch goroutine. Ordering and sequencing live in the pure helpers so the
 * no-burst contract is unit-pinned rather than incidental.
 *
 * ── Why the directory is re-resolved here ───────────────────────────────────
 * A tab's persisted `workingDirectory` can disagree with its own worktree
 * record. When it does, the worktree record wins — see
 * `resolveRestoredWorkingDirectory`. This site used to read the raw persisted
 * value, which is what restarted worktree conversations in their base repo and
 * let five of them interleave in one checkout.
 */
import type { PersistedTab } from '../../shared/types'
import { rInfo, rWarn } from '../rendererLogger'
import {
  readMainInstance,
  resolveRestoredWorkingDirectory,
  orderSessionCandidates,
  startSessionsSequentially,
  type RestoredTabRef,
} from './useTabRestoration-helpers'

/**
 * Start engine sessions for every restored plain conversation that has one.
 *
 * `worktreeAliveByIndex` carries the per-tab result of the caller's
 * "is this worktree still on disk" probe, keyed by saved-tab index. It is passed
 * in rather than re-probed so the session resolves the SAME directory the tab
 * state did; probing twice could return two different answers.
 */
export async function startRestoredSessions(
  restoredTabIds: RestoredTabRef[],
  savedTabs: PersistedTab[],
  activeTabIndex: number,
  worktreeAliveByIndex: Map<number, boolean>,
  persistedTabHasExtensions: (tab: PersistedTab) => boolean,
): Promise<void> {
  const sessionCandidates = restoredTabIds.filter(({ index }) => {
    const st = savedTabs[index]
    return st && !persistedTabHasExtensions(st) && !st.isTerminalOnly && st.conversationId
  })
  const activeFirst = orderSessionCandidates(sessionCandidates, activeTabIndex)

  await startSessionsSequentially(activeFirst, async ({ tabId, index }) => {
    const st = savedTabs[index]
    if (st.worktree?.landedAt) {
      rInfo('restore', 'skipped engine session start for landed worktree review', {
        tab_id: tabId.slice(0, 8),
        worktree_path: st.worktree.worktreePath,
      })
      return
    }

    // Read permission mode from the restored conversation instance (the
    // authoritative location post-WI-002). Fall back to the legacy tab-level
    // field for tabs persisted before WI-002.
    const restoredMain = readMainInstance(st)
    const sessionPermMode: 'auto' | 'plan' = restoredMain?.permissionMode ?? (st as any).permissionMode ?? 'auto'

    const sessionDir = resolveRestoredWorkingDirectory(st, worktreeAliveByIndex.get(index) ?? false)
    if (sessionDir !== st.workingDirectory) {
      // Worth an info line: it means the persisted path was stale, which is the
      // signature of the create-order defect this resolution exists to absorb.
      rInfo('restore', 'resolved session directory from the tab worktree', {
        tab_id: tabId.slice(0, 8), persisted: st.workingDirectory, resolved: sessionDir,
      })
    }

    try {
      const res = await window.ion.ensureEngineSession({
        tabId,
        workingDirectory: sessionDir,
        conversationId: st.conversationId!,
        permissionMode: sessionPermMode,
      })
      if (res?.ok) {
        rInfo('restore', 'eager session started', {
          tab_id: tabId.slice(0, 8),
          conversation_id: st.conversationId?.slice(0, 24) ?? '',
          dir: sessionDir,
        })
      } else {
        rWarn('restore', 'eager session start failed', { tab_id: tabId.slice(0, 8), error: res?.error ?? 'unknown' })
      }
    } catch (err: any) {
      rWarn('restore', 'eager session start threw', { tab_id: tabId.slice(0, 8), error: err?.message ?? String(err) })
    }
  })
}
