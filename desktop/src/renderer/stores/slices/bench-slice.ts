/**
 * Integration workspace (bench) store slice — navigation.
 *
 * Thin forwarders to the main process, which owns the workspace record. The
 * renderer holds a read model only, so overlay, Studio mirror, and iOS cannot
 * drift: they all render the same main-process truth.
 *
 * Multi-step flows live here as single actions (per AGENTS.md § Studio shell
 * rules) rather than in component handlers, which would run in whichever window
 * hosts them and decide against stale mirror state.
 *
 * Assembly and member-management actions (benchAssemble, benchResolveConflict,
 * the rerere trio, member add/remove/enable/order, and the absorbed-retired
 * notice) live in bench-slice-assembly.ts (file-size cap) — a distinct
 * cohesive concern from the navigation actions here. `ensureBenchDirectory`
 * is exported so that file can materialise the bench worktree before its own
 * mutations without duplicating the logic.
 */
import type { StoreSet, StoreGet, State } from "../session-store-types";
import type { IntegrationWorkspace } from "../../../shared/types";
import { rInfo, rWarn, rDebug } from "../../rendererLogger";
import {
  collectAllDirConversations,
  pickBenchConversation,
  pickNextConversation,
  pickDirTerminal,
  benchTerminalTitle,
} from "../../../shared/worktree-conversations";
import { deepEqual } from "../../../shared/deep-equal";

/**
 * Monotonic read generation per repo. A bench mutation invalidates every read
 * that started before it, so an older poll cannot restore stale member order.
 */
const benchRefreshGeneration = new Map<string, number>();

function nextBenchRefreshGeneration(repoPath: string): number {
  const generation = (benchRefreshGeneration.get(repoPath) ?? 0) + 1;
  benchRefreshGeneration.set(repoPath, generation);
  return generation;
}

export function invalidateBenchRefresh(repoPath: string): void {
  nextBenchRefreshGeneration(repoPath);
}

export function applyBenchWorkspace(
  set: StoreSet,
  repoPath: string,
  workspace: IntegrationWorkspace,
): void {
  set((state) => {
    const workspaces = state.benchWorkspaces.get(repoPath) ?? [];
    const index = workspaces.findIndex(
      (candidate) => candidate.sourceBranch === workspace.sourceBranch,
    );
    const next = [...workspaces];
    if (index >= 0) next[index] = workspace;
    else next.push(workspace);
    return {
      benchWorkspaces: new Map(state.benchWorkspaces).set(repoPath, next),
    };
  });
}

/**
 * In-flight singleton creation, keyed by bench path. Concurrent opens (overlay
 * click + Studio click + iOS command landing in the same owner window) must not
 * race past the "no singleton exists" check into two creations; the second
 * caller awaits the first creation and focuses its result. Module-level, not
 * store state: it is owner-window-local machinery (the same pattern as
 * resume-slice-hydration), and the mirror never executes this action.
 */
const inflightBenchConversations = new Map<string, Promise<string | null>>();

export function createBenchSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    refreshBench: async (repoPath) => {
      if (!repoPath || repoPath === "~") return;
      const generation = nextBenchRefreshGeneration(repoPath);
      try {
        const { workspaces, tips } = await window.ion.benchList(repoPath);
        // Refresh staleness for each workspace so the view is correct the
        // moment it renders (view-readiness), not a beat later.
        const refreshed: IntegrationWorkspace[] = [];
        for (const ws of workspaces) {
          const { workspace } = await window.ion.benchRefreshStaleness(
            repoPath,
            ws.sourceBranch,
          );
          refreshed.push(workspace ?? ws);
        }
        if (benchRefreshGeneration.get(repoPath) !== generation) {
          rDebug("bench", "stale refresh result discarded", {
            repo_path: repoPath,
            generation,
          });
          return;
        }
        // Write only on change, for the same reason `refreshWorktreeInventory`
        // does: an unconditional `new Map(...)` notifies every subscriber on
        // every pass, and a component effect that refreshes what it renders
        // then feeds itself — refresh → notify → re-render → refresh.
        const cachedWorkspaces = get().benchWorkspaces.get(repoPath);
        const cachedTips = get().benchSourceTips.get(repoPath);
        if (
          cachedWorkspaces &&
          deepEqual(cachedWorkspaces, refreshed) &&
          cachedTips &&
          deepEqual(cachedTips, tips)
        ) {
          rDebug("bench", "refresh found no change", {
            repo_path: repoPath,
            count: refreshed.length,
          });
        } else {
          set((s) => ({
            benchWorkspaces: new Map(s.benchWorkspaces).set(
              repoPath,
              refreshed,
            ),
            benchSourceTips: new Map(s.benchSourceTips).set(repoPath, tips),
          }));
          rDebug("bench", "refreshed", {
            repo_path: repoPath,
            count: refreshed.length,
          });
        }
      } catch (err) {
        rWarn("bench", "refresh failed", {
          repo_path: repoPath,
          error: String(err),
        });
      }
    },

    /**
     * Open or cycle bench conversations.
     *
     * Every entry point (git panel button, Studio, iOS command) cycles the
     * non-terminal tabs living in this bench, including an in-progress machine
     * auto-fix. The persistent `bench-conversation` role still identifies the
     * operator singleton created only when no conversation is open. A pre-role
     * legacy conversation is adopted when the cycle first reaches it.
     *
     * Concurrent opens serialize per bench through `inflightBenchConversations`
     * so two near-simultaneous requests cannot both observe "no singleton" and
     * create twins.
     */
    openBenchConversation: async (repoPath, sourceBranch) => {
      const workspaces = get().benchWorkspaces.get(repoPath) ?? [];
      const ws = workspaces.find((w) => w.sourceBranch === sourceBranch);
      if (!ws) {
        rWarn("bench", "no workspace to open", {
          repo_path: repoPath,
          source_branch: sourceBranch,
        });
        return null;
      }

      // The bench bar owns shared integration work, including a running
      // machine auto-fix. Cycle every non-terminal conversation in this bench
      // before creating the persistent operator singleton. Worktree rows stay
      // operator-only; only a bench makes machine work visible navigation.
      const found = pickBenchConversation(get().tabs, ws.benchPath);
      const matches = collectAllDirConversations(get().tabs, ws.benchPath);
      const next = pickNextConversation(matches, get().activeTabId);
      if (next) {
        if (found?.adopted && next.tabId === found.tab.id) {
          // A legacy operator conversation becomes the durable singleton the
          // first time the bench action reaches it, without stealing any
          // machine-owned auto-fix slot that shares this directory.
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === found.tab.id
                ? { ...t, tabRole: "bench-conversation" as const }
                : t,
            ),
          }));
        }
        rInfo("bench", "focusing bench conversation", {
          bench_path: ws.benchPath,
          tab_id: next.tabId.slice(0, 8),
          tab_role: next.tabRole ?? "operator",
          match_count: matches.length,
          adopted: String(
            found?.adopted === true && next.tabId === found.tab.id,
          ),
        });
        get().selectTab(next.tabId);
        return next.tabId;
      }

      // Serialize creation per bench: a second caller arriving while the first
      // is still creating awaits the same promise and focuses the result.
      const inflight = inflightBenchConversations.get(ws.benchPath);
      if (inflight) {
        rInfo("bench", "awaiting in-flight bench conversation creation", {
          bench_path: ws.benchPath,
        });
        const tabId = await inflight;
        if (tabId) get().selectTab(tabId);
        return tabId;
      }

      const creation = (async (): Promise<string | null> => {
        // Re-check under the "lock": a singleton may have appeared between the
        // first check and this task starting (e.g. restoration finishing).
        const recheckMatches = collectAllDirConversations(
          get().tabs,
          ws.benchPath,
        );
        const recheckNext = pickNextConversation(
          recheckMatches,
          get().activeTabId,
        );
        if (recheckNext) {
          const recheckSingleton = pickBenchConversation(
            get().tabs,
            ws.benchPath,
          );
          if (
            recheckSingleton?.adopted &&
            recheckNext.tabId === recheckSingleton.tab.id
          ) {
            set((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === recheckSingleton.tab.id
                  ? { ...t, tabRole: "bench-conversation" as const }
                  : t,
              ),
            }));
          }
          rInfo("bench", "focusing bench conversation after creation recheck", {
            bench_path: ws.benchPath,
            tab_id: recheckNext.tabId.slice(0, 8),
            tab_role: recheckNext.tabRole ?? "operator",
            match_count: recheckMatches.length,
          });
          get().selectTab(recheckNext.tabId);
          return recheckNext.tabId;
        }

        // The bench worktree may not exist on disk until the first assembly, so
        // materialise it before opening a conversation that would otherwise land
        // in a missing directory.
        if (!(await ensureBenchDirectory(repoPath, ws, get))) return null;

        rInfo("bench", "creating bench conversation", {
          bench_path: ws.benchPath,
        });
        // useWorktree=false: the bench IS a worktree already and must never get
        // one nested inside it. It is also deliberately not enrolled as a member
        // of itself.
        const tabId = await get().createTabInDirectory(
          ws.benchPath,
          false,
          true,
        );
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId
              ? { ...t, tabRole: "bench-conversation" as const }
              : t,
          ),
        }));
        return tabId;
      })();

      inflightBenchConversations.set(ws.benchPath, creation);
      try {
        return await creation;
      } finally {
        inflightBenchConversations.delete(ws.benchPath);
      }
    },

    /**
     * Cycle to the NEXT already-open conversation in this bench, relative to
     * the currently focused tab. Distinct from openBenchConversation (which
     * additionally creates the persistent singleton on first open): this is
     * the bench bar's repeated "cycle" control, invoked while a bench
     * conversation is already the focus.
     *
     * ONE forwarded owner action rather than a component handler computing
     * pickNextConversation(benchConversations, activeTabId) itself: the
     * component's benchConversations is `tabs`-derived (kept in sync between
     * windows), but activeTabId is a mirror-local COPY of the owner's value,
     * delivered by an async push — reading it in a component handler risks
     * cycling from a briefly-stale "current" tab. get().activeTabId inside
     * this action always reads the OWNER's live value when the action
     * executes in the owner (forwarded), matching the exact pattern
     * openBenchConversation already uses for its own pickNextConversation call.
     */
    cycleBenchConversation: (repoPath, sourceBranch) => {
      const workspaces = get().benchWorkspaces.get(repoPath) ?? [];
      const ws = workspaces.find((w) => w.sourceBranch === sourceBranch);
      if (!ws) {
        rWarn("bench", "cycle refused: no workspace", {
          repo_path: repoPath,
          source_branch: sourceBranch,
        });
        return;
      }
      const matches = collectAllDirConversations(get().tabs, ws.benchPath);
      const next = pickNextConversation(matches, get().activeTabId);
      if (!next) {
        rDebug("bench", "cycle: no open bench conversation to focus", {
          bench_path: ws.benchPath,
        });
        return;
      }
      rInfo("bench", "cycled to bench conversation", {
        bench_path: ws.benchPath,
        tab_id: next.tabId.slice(0, 8),
        match_count: matches.length,
      });
      get().selectTab(next.tabId);
    },

    /**
     * Open (or focus) the bench's ONE dedicated terminal tab.
     *
     * Development in a bench is mostly shell work — build, test, run — and the
     * generic new-terminal path stacks a fresh tab per use, so the operator
     * accumulates identical shells and loses the scrollback they were reading.
     * This always lands on the same tab for a given bench, and the terminal
     * strip's `+` multiplexes inside it, so one tab hosts as many shells as the
     * work needs.
     *
     * Identity is derived, never stored: see `pickDirTerminal`. The consequence
     * worth naming is that closing the tab is a complete reset — the next press
     * opens a fresh one, with nothing to reconcile.
     */
    openBenchTerminal: async (repoPath, sourceBranch) => {
      const workspaces = get().benchWorkspaces.get(repoPath) ?? [];
      const ws = workspaces.find((w) => w.sourceBranch === sourceBranch);
      if (!ws) {
        rWarn("bench", "no workspace for terminal", {
          repo_path: repoPath,
          source_branch: sourceBranch,
        });
        return null;
      }

      const title = benchTerminalTitle(sourceBranch);
      const existing = pickDirTerminal(get().tabs, ws.benchPath, title);
      if (existing) {
        rInfo("bench", "focusing existing bench terminal", {
          bench_path: ws.benchPath,
          tab_id: existing.id.slice(0, 8),
          adopted: String(existing.customTitle !== title),
        });
        get().selectTab(existing.id);
        // Tier-2 hit: a terminal that was already in the bench directory but
        // not named by Ion. Name it so the next press matches on tier 1 — but
        // only when the operator has not titled it themselves, because their
        // name is the one thing here we must never overwrite.
        if (!existing.customTitle) get().renameTab(existing.id, title);
        return existing.id;
      }

      // No terminal yet, so the directory has to be real before one opens in
      // it. A shell whose cwd does not exist is the defect, not a fallback.
      if (!(await ensureBenchDirectory(repoPath, ws, get))) return null;

      const tabId = await get().createTerminalTab(ws.benchPath);
      get().renameTab(tabId, title);
      rInfo("bench", "opened bench terminal", {
        bench_path: ws.benchPath,
        tab_id: tabId.slice(0, 8),
      });
      return tabId;
    },
  };
}

/**
 * Make sure the bench directory exists on disk, building it when it does not.
 *
 * Returns false when the bench could not be materialised, which the callers
 * treat as "do not open anything" — landing a conversation or a shell in a
 * directory that is not there produces an engine session with a dead cwd, which
 * fails later and further from the cause.
 *
 * ── Two reasons the directory can be missing ────────────────────────────────
 * `lastBuiltAt === 0` is the first-run case: enrollment creates the workspace
 * RECORD, and the first assembly is what creates the directory. That check alone
 * was the previous behaviour and it is not sufficient — a bench that HAS been
 * built can still have its directory removed out from under Ion (deleted by
 * hand, pruned with `git worktree prune`, a wiped `~/.ion/integration`), and the
 * record keeps its build timestamp. So existence is checked too, and either
 * answer triggers the same assembly.
 *
 * Exported for bench-slice-assembly.ts, whose mutations also require the
 * bench worktree to exist on disk before they run.
 */
export async function ensureBenchDirectory(
  repoPath: string,
  ws: IntegrationWorkspace,
  get: StoreGet,
): Promise<boolean> {
  const neverBuilt = ws.lastBuiltAt === 0;
  // Only worth an IPC round trip when the record claims a build happened.
  const missing =
    neverBuilt || !(await window.ion.fsExists(ws.benchPath)).exists;
  if (!missing) return true;

  rInfo("bench", "materialising bench directory before use", {
    repo_path: repoPath,
    source_branch: ws.sourceBranch,
    bench_path: ws.benchPath,
    reason: neverBuilt ? "never_built" : "directory_gone",
  });
  const built = await window.ion.benchAssemble(repoPath, ws.sourceBranch);
  if (!built.ok) {
    rWarn("bench", "bench build failed; nothing opened", {
      source_branch: ws.sourceBranch,
      error: built.error ?? "",
    });
    return false;
  }
  await get().refreshBench(repoPath);
  return true;
}
