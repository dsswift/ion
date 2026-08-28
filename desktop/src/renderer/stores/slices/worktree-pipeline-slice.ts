/**
 * Worktree sync pipeline — the one-verb path from "the source branch moved"
 * back to a green board.
 *
 * ── Phases ──────────────────────────────────────────────────────────────────
 *   1. `syncing`             — the bulk mechanical pass (main/worktree/
 *      sync-all.ts): precise rebases, rerere replay, zero token spend.
 *   2. `awaiting-ai-confirm` — conflicts survived the free pass. The pipeline
 *      STOPS and names them; agents cost money, so launching them is the
 *      operator's explicit act (the confirm dialog is the cost-visibility
 *      gate). A zero-conflict pass skips this phase entirely.
 *   3. `resolving`           — one agent at a time, deliberately sequential:
 *      every completed resolution records into the repo's shared rerere
 *      cache, and the mechanical re-pass BETWEEN agents replays it — so the
 *      Nth identical conflict is resolved for free rather than by the Nth
 *      agent. Parallel launches would pay full price for all of them.
 *   4. `assembling`          — bench update-all + assembly (existing action),
 *      when a bench exists. Safe post-sync: the sync rewrote the worktrees'
 *      commits, so any pre-sync pin is stale by definition (see
 *      worktreeRowState.ts on why sync outranks the pin).
 *
 * ── Why ONE store action per phase transition (Studio rule) ────────────────────
 * The pipeline reads store state between mutations (tab status while an agent
 * runs, the bench list for phase 4), so it must run in the owner window as
 * forwarded actions — a component handler would decide against stale mirror
 * state. See studio-mirror-actions.ts.
 *
 * ── Cancellation semantics ──────────────────────────────────────────────────
 * Cancel stops the pipeline BETWEEN steps: no new agent launches, no phase 4.
 * It never aborts an in-flight rebase (git owns that state; the ConflictsDialog
 * is the abort surface) and never interrupts a running agent (its resolution
 * is already paid for — let it record into rerere).
 */
import type { StoreSet, StoreGet, State, WorktreePipelineState } from '../session-store-types'
import { rInfo, rWarn, rDebug } from '../../rendererLogger'
import type { SyncAllWorktreeOutcome } from '../../../shared/types'

/** Poll cadence while waiting for an assist agent to finish a rebase. */
const RESOLVE_POLL_MS = 3000
/**
 * Per-worktree ceiling on the agent wait. An agent that has neither finished
 * the rebase nor gone idle after this long is treated as needs-manual so the
 * pipeline cannot hang the whole board on one stuck conversation. Generous on
 * purpose: a real resolution involves reading the conflict, editing, and
 * `rebase --continue`.
 */
const RESOLVE_TIMEOUT_MS = 15 * 60 * 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The conflicted worktrees of a sync-all outcome list, in pass order. */
function conflictedOf(outcomes: SyncAllWorktreeOutcome[]): SyncAllWorktreeOutcome[] {
  return outcomes.filter((o) => o.outcome === 'conflicted')
}

export function createWorktreePipelineSlice(set: StoreSet, get: StoreGet): Partial<State> {
  /** Merge a partial update into the live pipeline state (no-op when idle). */
  function patch(update: Partial<WorktreePipelineState>): void {
    set((s) => (s.worktreePipeline ? { worktreePipeline: { ...s.worktreePipeline, ...update } } : {}))
  }

  /**
   * Phase 4 + terminal summary. Factored out because both the zero-conflict
   * path (start → assemble) and the post-resolution path (confirm → assemble)
   * end here, and the summary must be worded identically for both.
   */
  async function assembleAndFinish(): Promise<void> {
    const p = get().worktreePipeline
    if (!p) return
    if (p.cancelled) {
      patch({ phase: 'done', summary: summarize(p, 'cancelled') })
      return
    }

    // A bench is optional: the pipeline is about worktrees first. Update-all
    // both advances stale pins and assembles, which is exactly the existing
    // BenchBar verb — reused, not reimplemented.
    const bench = (get().benchWorkspaces.get(p.repoPath) ?? [])
      .find((w) => w.sourceBranch === p.sourceBranch)
    if (p.sourceBranch && bench) {
      patch({ phase: 'assembling' })
      rInfo('worktree.pipeline', 'assembling bench', { repo_path: p.repoPath, source_branch: p.sourceBranch })
      try {
        const result = await get().benchUpdateAll(p.repoPath, p.sourceBranch)
        if (!result.ok) {
          rWarn('worktree.pipeline', 'bench update-all failed', { error: result.error ?? '' })
          patch({ phase: 'failed', summary: `Source sync: ${summarizeSync(p)} · Bench build failed: ${result.error ?? 'unknown error'}` })
          return
        }
        patch({ benchMemberCount: result.workspace?.members.length ?? bench.members.length })
      } catch (err) {
        rWarn('worktree.pipeline', 'bench update-all threw', { error: String(err) })
        patch({ phase: 'failed', summary: `Source sync: ${summarizeSync(p)} · Bench build failed: ${String(err)}` })
        return
      }
    } else {
      rDebug('worktree.pipeline', 'no bench for branch, skipping assembly phase', {
        repo_path: p.repoPath, source_branch: p.sourceBranch ?? '',
      })
    }

    await get().refreshWorktreeInventory(p.repoPath)
    await get().refreshBench(p.repoPath)
    const final = get().worktreePipeline
    if (!final) return
    patch({ phase: 'done', summary: summarize(final, 'completed') })
    rInfo('worktree.pipeline', 'pipeline done', {
      repo_path: final.repoPath,
      needs_manual: final.needsManual.length,
      summary: summarize(final, 'completed'),
    })
  }

  /** The source-sync result without any bench-build claim. */
  function summarizeSync(p: WorktreePipelineState): string {
    const s = p.lastSummary
    const parts: string[] = []
    if (s) {
      if (s.synced > 0) parts.push(`${s.synced} synced`)
      if (s.replayed > 0) parts.push(`${s.replayed} completed by replay`)
      if (s.skippedDirty > 0) parts.push(`${s.skippedDirty} blocked by uncommitted changes`)
      if (s.skippedUnknownSource > 0) parts.push(`${s.skippedUnknownSource} skipped (unknown source)`)
      if (s.failed > 0) parts.push(`${s.failed} failed`)
    }
    if (p.resolvedByAi > 0) parts.push(`${p.resolvedByAi} resolved by AI`)
    if (p.needsManual.length > 0) parts.push(`${p.needsManual.length} need manual resolution`)
    return parts.length > 0 ? parts.join(', ') : 'all worktrees already current'
  }

  /** One human sentence for the banner and the logs. */
  function summarize(p: WorktreePipelineState, ending: 'completed' | 'cancelled'): string {
    const sync = summarizeSync(p)
    if (ending === 'cancelled') return `Cancelled — Source sync: ${sync}`
    const sourceSummary = `Source sync: ${sync}`
    return p.benchMemberCount === undefined
      ? sourceSummary
      : `${sourceSummary} · Bench built with ${p.benchMemberCount} member${p.benchMemberCount === 1 ? '' : 's'}`
  }

  /**
   * The free pass: run sync-all and update the pipeline's outcome book-keeping.
   * Returns the still-conflicted set (excluding worktrees already parked as
   * needs-manual, whose conflicts an agent already failed to clear).
   */
  async function mechanicalPass(): Promise<SyncAllWorktreeOutcome[]> {
    const p = get().worktreePipeline
    if (!p) return []
    const result = await window.ion.gitWorktreeSyncAll(p.repoPath)
    const conflicted = conflictedOf(result.outcomes)
      .filter((o) => !get().worktreePipeline?.needsManual.includes(o.worktreePath))
    patch({
      outcomes: result.outcomes,
      lastSummary: result.summary,
      queue: conflicted.map((o) => o.worktreePath),
    })
    rInfo('worktree.pipeline', 'mechanical pass finished', {
      repo_path: p.repoPath,
      synced: result.summary.synced,
      replayed: result.summary.replayed,
      conflicted: result.summary.conflicted,
      skipped_dirty: result.summary.skippedDirty,
      skipped_unknown_source: result.summary.skippedUnknownSource,
      failed: result.summary.failed,
    })
    return conflicted
  }

  /**
   * Wait for the assist agent on `directory` to finish its rebase.
   * Resolution is detected from GIT, not from the conversation: the operation
   * state clearing is the ground truth that the rebase completed. The tab
   * going quiet while conflicts remain is the needs-manual signal.
   */
  async function waitForResolution(directory: string, tabId: string): Promise<'resolved' | 'needs-manual'> {
    const deadline = Date.now() + RESOLVE_TIMEOUT_MS
    for (;;) {
      await sleep(RESOLVE_POLL_MS)
      try {
        const op = await window.ion.gitOpState(directory)
        if (op.ok && !op.state) return 'resolved'
        const tab = get().tabs.find((t) => t.id === tabId)
        const tabQuiet = !tab || tab.status === 'idle' || tab.status === 'completed'
          || tab.status === 'failed' || tab.status === 'dead'
        if (tabQuiet) {
          // One grace re-check: the agent may have just run `--continue` and
          // the op state read raced it.
          await sleep(RESOLVE_POLL_MS)
          const recheck = await window.ion.gitOpState(directory)
          if (recheck.ok && !recheck.state) return 'resolved'
          rWarn('worktree.pipeline', 'assist went quiet with conflicts remaining', {
            directory, tab_id: tabId.slice(0, 8), tab_status: tab?.status ?? 'gone',
          })
          return 'needs-manual'
        }
      } catch (err) {
        rWarn('worktree.pipeline', 'resolution poll failed, retrying', { directory, error: String(err) })
      }
      if (Date.now() > deadline) {
        rWarn('worktree.pipeline', 'assist timed out, marking needs-manual', {
          directory, tab_id: tabId.slice(0, 8), timeout_ms: RESOLVE_TIMEOUT_MS,
        })
        return 'needs-manual'
      }
    }
  }

  return {
    worktreePipeline: null,

    /**
     * Phase 1: the free pass. Ends in `awaiting-ai-confirm` when conflicts
     * survive it, or runs straight through to assembly when none do.
     *
     * Refuses to stack: a pipeline already running for ANY repo keeps running
     * (two pipelines would interleave their sync-alls on the same rr-cache).
     */
    startWorktreePipeline: async (repoPath, sourceBranch) => {
      const existing = get().worktreePipeline
      if (existing && existing.phase !== 'done' && existing.phase !== 'failed') {
        rWarn('worktree.pipeline', 'refused: a pipeline is already running', {
          running_repo: existing.repoPath, requested_repo: repoPath,
        })
        return
      }
      rInfo('worktree.pipeline', 'starting', { repo_path: repoPath, source_branch: sourceBranch ?? '' })
      set(() => ({
        worktreePipeline: {
          repoPath,
          sourceBranch: sourceBranch ?? null,
          phase: 'syncing',
          outcomes: [],
          queue: [],
          current: null,
          needsManual: [],
          resolvedByAi: 0,
          cancelled: false,
          startedAt: Date.now(),
        } satisfies WorktreePipelineState,
      }))

      let conflicted: SyncAllWorktreeOutcome[]
      try {
        conflicted = await mechanicalPass()
      } catch (err) {
        rWarn('worktree.pipeline', 'mechanical pass failed', { repo_path: repoPath, error: String(err) })
        patch({ phase: 'failed', summary: `Sync pass failed: ${String(err)}` })
        return
      }
      await get().refreshWorktreeInventory(repoPath)

      if (get().worktreePipeline?.cancelled) {
        patch({ phase: 'done', summary: summarize(get().worktreePipeline!, 'cancelled') })
        return
      }
      if (conflicted.length === 0) {
        await assembleAndFinish()
        return
      }
      // The gate. Agents launch only after confirmWorktreePipelineAi().
      rInfo('worktree.pipeline', 'conflicts remain, awaiting AI confirmation', {
        repo_path: repoPath, conflicted: conflicted.length,
      })
      patch({ phase: 'awaiting-ai-confirm' })
    },

    /**
     * Phase 3: sequential AI escalation over the confirmed queue.
     *
     * Between agents the mechanical pass re-runs: the resolution the previous
     * agent just recorded may clear several remaining worktrees by replay,
     * and paying an agent for a conflict rerere can already answer would be
     * the exact waste this pipeline exists to remove.
     */
    confirmWorktreePipelineAi: async () => {
      const p = get().worktreePipeline
      if (!p || p.phase !== 'awaiting-ai-confirm') {
        rWarn('worktree.pipeline', 'confirm ignored: no pipeline awaiting confirmation', {
          phase: p?.phase ?? 'none',
        })
        return
      }
      rInfo('worktree.pipeline', 'AI escalation confirmed', {
        repo_path: p.repoPath, queued: p.queue.length,
      })
      patch({ phase: 'resolving' })

      for (;;) {
        const live = get().worktreePipeline
        if (!live || live.cancelled) break
        const next = live.queue[0]
        if (!next) break

        patch({ current: next })
        let tabId: string
        try {
          // The existing assist verb, unchanged: fresh conversation in the
          // conflicted directory, standard tier, auto mode, locked input.
          tabId = await get().openConflictAssist(next)
        } catch (err) {
          // A refusal (no standard tier) applies to every queue entry alike —
          // park them all as needs-manual rather than failing one at a time.
          rWarn('worktree.pipeline', 'assist launch refused, parking queue as needs-manual', {
            directory: next, error: String(err),
          })
          const remaining = get().worktreePipeline?.queue ?? []
          patch({
            current: null,
            queue: [],
            needsManual: [...(get().worktreePipeline?.needsManual ?? []), ...remaining],
            summary: err instanceof Error ? err.message : String(err),
          })
          break
        }

        const verdict = await waitForResolution(next, tabId)
        // Drop the processed entry NOW, not only via the mechanical re-pass
        // below: if that pass throws, a stale queue[0] would re-launch an
        // agent for a directory that was already handled — forever.
        if (verdict === 'resolved') {
          rInfo('worktree.pipeline', 'assist resolved the rebase', { directory: next })
          patch({
            current: null,
            queue: (get().worktreePipeline?.queue ?? []).filter((d) => d !== next),
            resolvedByAi: (get().worktreePipeline?.resolvedByAi ?? 0) + 1,
          })
          // The assist tab has served its purpose: its one machine prompt is
          // answered and the rebase is finished. A dozen-worktree pipeline
          // would otherwise leave a dozen dead tabs behind. Closing is cheap
          // and reversible (the conversation persists and is resumable from
          // the session browser; the worktree is untouched by design), and
          // the tab is idle so the close guard has nothing to block. A
          // NEEDS-MANUAL tab is deliberately kept: its transcript is the
          // operator's evidence for what the agent tried.
          get().closeTab(tabId)
          rInfo('worktree.pipeline', 'assist tab closed after resolution', {
            directory: next, tab_id: tabId.slice(0, 8),
          })
        } else {
          patch({
            current: null,
            queue: (get().worktreePipeline?.queue ?? []).filter((d) => d !== next),
            needsManual: [...(get().worktreePipeline?.needsManual ?? []), next],
          })
        }

        if (get().worktreePipeline?.cancelled) break

        // The cascade: replay whatever the last resolution recorded before
        // deciding whether the next worktree still needs an agent at all.
        try {
          await mechanicalPass()
        } catch (err) {
          rWarn('worktree.pipeline', 'inter-agent mechanical pass failed', { error: String(err) })
        }
        await get().refreshWorktreeInventory(get().worktreePipeline?.repoPath ?? '')
      }

      await assembleAndFinish()
    },

    /**
     * Stop between steps. Never aborts an in-flight rebase or interrupts a
     * running agent — see the module comment for why both stay untouched.
     */
    cancelWorktreePipeline: () => {
      const p = get().worktreePipeline
      if (!p || p.phase === 'done' || p.phase === 'failed') return
      rInfo('worktree.pipeline', 'cancel requested', { repo_path: p.repoPath, phase: p.phase })
      if (p.phase === 'awaiting-ai-confirm') {
        // Nothing is in flight at the gate: declining IS the terminal state.
        patch({ cancelled: true, phase: 'done', summary: summarize({ ...p, cancelled: true }, 'cancelled') })
        return
      }
      patch({ cancelled: true })
    },

    /** Clear the finished banner. */
    dismissWorktreePipeline: () => {
      const p = get().worktreePipeline
      if (!p) return
      if (p.phase !== 'done' && p.phase !== 'failed') {
        rDebug('worktree.pipeline', 'dismiss ignored: pipeline still running', { phase: p.phase })
        return
      }
      set(() => ({ worktreePipeline: null }))
    },
  }
}
