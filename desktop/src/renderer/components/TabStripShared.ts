import { useSessionStore } from "../stores/sessionStore";
import { usePreferencesStore } from "../preferences";
import type { useColors } from "../theme";
import type { TabState } from "../../shared/types";
import type { ConversationPane } from "../../shared/types-engine";
import { activeInstance } from "../stores/conversation-instance";
import { tabHasExtensions as _tabHasExtensions } from "../../shared/tab-predicates";
import { rDebug } from "../rendererLogger";
import {
  STATUS_PRIORITY_BASH,
  STATUS_PRIORITY_BASH_BACKGROUND,
  STATUS_PRIORITY_CHILDREN,
  STATUS_PRIORITY_ERROR,
  STATUS_PRIORITY_IDLE,
  STATUS_PRIORITY_PERMISSION,
  STATUS_PRIORITY_PLAN_READY,
  STATUS_PRIORITY_QUESTION,
  STATUS_PRIORITY_RUNNING,
  STATUS_PRIORITY_UNREAD,
} from "./TabStripStatusPriority";
export { tabHasExtensions } from "../../shared/tab-predicates";

export {
  PILL_COLOR_PRESETS,
  PILL_ICON_PRESETS,
  PILL_ICON_MAP,
} from "./TabStripPillPresets";

/** Decide whether a tab-creation event should use worktree mode. Holding Alt inverts the default. */
export const shouldUseWorktree = (altKey: boolean): boolean => {
  const gitOpsMode = usePreferencesStore.getState().gitOpsMode;
  return altKey ? gitOpsMode !== "worktree" : gitOpsMode === "worktree";
};

/** On-demand uncommitted check for worktree tabs whose status isn't in the map yet. */
export function checkWorktreeUncommitted(tab: TabState | undefined): void {
  if (!tab?.worktree) return;
  const { worktreeUncommittedMap, setWorktreeUncommitted } =
    useSessionStore.getState();
  if (worktreeUncommittedMap.has(tab.id)) return;
  window.ion
    .gitChanges(tab.workingDirectory)
    .then((result) => {
      setWorktreeUncommitted(tab.id, result.files.length > 0);
    })
    .catch((err) =>
      rDebug("tabstrip", "gitChanges probe failed", {
        tab_id: tab.id,
        error: String(err),
      }),
    );
}

/** Compact relative-time formatter for tab-pill subtitles. */
export function formatRelativeShort(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

/** Tristate "waiting for the user" derived from queued permission denials. */
export type WaitingState = "plan-ready" | "question" | null;

/** Derive the waiting state from a denial-tools array. Returns 'question'
 *  if any tool is AskUserQuestion, else 'plan-ready' if any is
 *  ExitPlanMode, else null. Shared by both CLI and engine paths. */
function waitingStateFromTools(
  tools: ReadonlyArray<{ toolName: string }> | undefined | null,
): WaitingState {
  if (!tools?.length) return null;
  if (tools.some((t) => t.toolName === "AskUserQuestion")) return "question";
  if (tools.some((t) => t.toolName === "ExitPlanMode")) return "plan-ready";
  return null;
}

/**
 * Derive the waiting state from a tab's pending denials.
 *
 * Both CLI and engine tabs now store `permissionDenied` on their
 * `ConversationInstance`(s) in `conversationPanes` — the previous
 * `tab.permissionDenied` vs. per-instance fork is gone.
 *
 * - Normal (single-instance) tabs: read from the active `main` instance
 *   via `activeInstance(conversationPanes, tab.id)`.
 * - Engine tabs (`tabHasExtensions(tab) === true`): fold across every engine
 *   instance under this tab in `conversationPanes`, returning the
 *   worst-priority waiting state ('question' > 'plan-ready' > null).
 *
 * Engine sub-tabs (instances) are independent sub-conversations and
 * each may have its own pending question or plan card. Parent-pill
 * glow must surface "any sub-tab is blocked," so we walk all the
 * instances in the pane. `conversationPanes` is threaded in by reactive
 * callers (the render callsites already subscribe to it) so this
 * function stays a pure derivation; it is optional and falls back to a
 * one-shot store read for the few non-reactive callers that don't hold
 * the map, matching the consistency the old store-reading body had.
 */
export function getWaitingState(
  tab: TabState,
  conversationPanes: Map<string, ConversationPane> = useSessionStore.getState()
    .conversationPanes,
): WaitingState {
  return waitingStateOfPane(conversationPanes.get(tab.id));
}

/**
 * Pane-scoped form of {@link getWaitingState}, for a component that subscribes
 * to one tab's pane instead of the whole `conversationPanes` map.
 */
export function waitingStateOfPane(
  pane: ConversationPane | undefined,
): WaitingState {
  // DATA-driven (not tab-type): fold the waiting state across ALL of the tab's
  // instances. A plain conversation has a single `main` instance, so the fold
  // collapses to reading that one instance's permissionDenied; an
  // extension-backed tab folds across its instances. One path for both.
  if (!pane || pane.instances.length === 0) return null;
  let hasPlanReady = false;
  for (const inst of pane.instances) {
    const ws = waitingStateFromTools(inst.permissionDenied?.tools);
    if (ws === "question") return "question";
    if (ws === "plan-ready") hasPlanReady = true;
  }
  return hasPlanReady ? "plan-ready" : null;
}

/**
 * Check whether any engine instance under a tab is currently running.
 * Folds across `conversationPanes` instances and reads per-instance state
 * from `engineStatusFields` — parallel to how `getWaitingState` folds
 * across `enginePermissionDenied` for denial aggregation.
 *
 * NOTE: This reads from `useSessionStore.getState()` — it is not
 * reactive on its own. Callers in React components must separately
 * subscribe to `engineStatusFields` (or a projection of it) so the
 * component re-renders when instance states change.
 */
// ─── Activity folds (re-exported) ──────────────────────────────────────────
//
// The "is work in flight?" fold cluster lives in TabStripActivityFolds.ts
// (extracted at the file-size cap). Re-exported here so every existing import
// site keeps working and the cascade below can use them unqualified.
export * from "./TabStripActivityFolds";
// Imported as well as re-exported: the cascade below uses these three
// unqualified, and `export *` alone does not bind them in this module's scope.
import {
  isAnyEngineInstanceRunning,
  anyEngineInstanceHasRunningChildren,
  anyEngineInstanceHasRunningShells,
} from "./TabStripActivityFolds";

// ─── Harness badge helpers ─────────────────────────────────────────────────
//
// The harness badge is a small rectangular text chip shown on every tab pill
// that has extensions loaded. It shows an abbreviated profile name so the
// user can see at a glance which harness is running — useful when multiple
// engine-tab profiles are open side by side.
//
// Phase gate: visibility is intentionally behind `tabHasExtensions` (imported
// from shared/tab-predicates.ts, the single source of truth for extension
// presence). The predicate derives from `tab.engineProfileId`, replacing the
// old stored `hasEngineExtension` boolean.
// Re-exported at the top of this file so existing importers keep working.

/**
 * Abbreviate a profile name to at most 8 characters for the harness badge.
 *
 * Rules (applied in order):
 *  1. Falsy name → 'EXT'
 *  2. Strip leading/trailing whitespace.
 *  3. If the stripped name is ≤ 8 chars → return it as-is (e.g. 'COS', 'Orion', 'ion-dev').
 *  4. Split into words, take the first letter of each word, uppercase it,
 *     join, cap at 8 chars (e.g. 'Ion Dev' → 'ID', 'My Long Name X' → 'MLN').
 *  5. Fallback: first 8 chars uppercased.
 */
export function abbreviateProfileName(name: string | null | undefined): string {
  if (!name) return "EXT";
  const trimmed = name.trim();
  if (!trimmed) return "EXT";
  if (trimmed.length <= 8) return trimmed;
  // Initials from whitespace-separated words
  const words = trimmed.split(/\s+/);
  if (words.length > 1) {
    const initials = words.map((w) => w[0].toUpperCase()).join("");
    return initials.slice(0, 8);
  }
  // Single long word: first 8 chars uppercased
  return trimmed.slice(0, 8).toUpperCase();
}

// ─── Status-color priority table ───────────────────────────────────────────
//
// `getTabStatusColor` and `getGroupStatusColor` use values derived from the
// shared local declaration in TabStripStatusPriority.ts. That declaration is
// independently asserted against assets/design-system/status-cascade.json.

/** Status-dot color/pulse/glow derived from a tab's runtime state.
 *
 *  The returned `priority` field lets `getGroupStatusColor` fold across
 *  all tabs in a group using the same single ranking, eliminating a
 *  parallel inline cascade. Higher priority wins. */
export function getTabStatusColor(
  tab: TabState,
  colors: ReturnType<typeof useColors>,
): {
  bg: string;
  pulse: boolean;
  glow: boolean;
  glowColor: string;
  priority: number;
} {
  let bg = colors.statusIdle;
  let pulse = false;
  let glow = false;
  let glowColor = colors.statusPermissionGlow;

  // Both waiting-state and the permission queue now live on the tab's
  // active ConversationInstance in conversationPanes (the `tab.permissionDenied`
  // / `tab.permissionQueue` fields are gone). Read the store directly here:
  // this is a non-reactive helper; its callers re-render on conversationPanes
  // identity changes via their `s.conversationPanes` subscriptions, so the
  // read is consistent at render time.
  const conversationPanes = useSessionStore.getState().conversationPanes;
  const inst = activeInstance(conversationPanes, tab.id);
  const permissionQueueLength = inst?.permissionQueue.length ?? 0;

  const waitingState = getWaitingState(tab, conversationPanes);

  let priority: number;

  if (tab.status === "dead" || tab.status === "failed") {
    bg = colors.statusError;
    priority = STATUS_PRIORITY_ERROR;
  } else if (permissionQueueLength > 0) {
    bg = colors.statusPermission;
    glow = true;
    priority = STATUS_PRIORITY_PERMISSION;
  } else if (
    tab.status === "connecting" ||
    tab.status === "running" ||
    isAnyEngineInstanceRunning(tab.id)
  ) {
    // Orange "foreground running" wins over amber "background only" —
    // the orchestrator's own activity is the strongest signal. Amber
    // "awaiting children" fires below for the case where orchestrator
    // is idle but dispatched agents are still executing. Data-driven: the
    // instance fold runs for every tab (a plain conversation with background
    // agents qualifies too), so no tab-type guard.
    bg = colors.statusRunning;
    pulse = true;
    priority = STATUS_PRIORITY_RUNNING;
  } else if (anyEngineInstanceHasRunningChildren(tab.id)) {
    // Yellow "awaiting children" — orchestrator idle, dispatched
    // background agents still running. Visually distinct from the
    // terracotta running state so users can tell at a glance whether
    // foreground or background work is in flight. Glow uses the
    // matching amber tint so the rim around the pill stays in palette.
    // Outranks plan-ready: active background work is a stronger signal
    // than a passive "waiting on you" state.
    bg = colors.statusWaitingChildren;
    pulse = true;
    glow = true;
    glowColor = colors.statusWaitingChildrenGlow;
    priority = STATUS_PRIORITY_CHILDREN;
  } else if (anyEngineInstanceHasRunningShells(tab.id)) {
    // Pink "waiting on background shells" — orchestrator idle, background
    // bash commands still running. Same treatment as the user-typed `!`
    // command below (identical color): the dot answers "a shell is executing
    // in this tab", not "who started it". Ranked just under children because
    // agents and shells can be outstanding at once and the agent signal is
    // the richer one; both outrank the passive plan-ready / question states,
    // for the same reason the children branch does.
    bg = colors.statusBash;
    pulse = true;
    glow = true;
    glowColor = colors.statusBashGlow;
    priority = STATUS_PRIORITY_BASH_BACKGROUND;
  } else if (waitingState === "plan-ready") {
    bg = colors.statusComplete;
    glow = true;
    glowColor = colors.tabGlowPlanReady;
    priority = STATUS_PRIORITY_PLAN_READY;
  } else if (waitingState === "question") {
    bg = colors.statusQuestion;
    glow = true;
    glowColor = colors.tabGlowQuestion;
    priority = STATUS_PRIORITY_QUESTION;
  } else if (tab.bashExecuting) {
    bg = colors.statusBash;
    pulse = true;
    glow = true;
    glowColor = colors.statusBashGlow;
    priority = STATUS_PRIORITY_BASH;
  } else if (tab.hasUnread) {
    bg = colors.statusComplete;
    priority = STATUS_PRIORITY_UNREAD;
  } else {
    priority = STATUS_PRIORITY_IDLE;
  }

  return { bg, pulse, glow, glowColor, priority };
}

/**
 * Derive the highest-priority status dot for a group of tabs.
 *
 * Re-exported from TabStripGroupStatus.ts (extracted to keep TabStripShared.ts
 * under the 600-line cap). Consumers import from here as usual.
 */
export { getGroupStatusColor, getGroupDotModel } from "./TabStripGroupStatus";
export type { GroupDotModel } from "./TabStripGroupStatus";

/** Model-fallback fact stored per engine instance. */
export interface TabModelFallback {
  requestedModel: string;
  fallbackModel: string;
  reason: string;
  at: number;
}

/**
 * Resolve the model-fallback fact for a tab's active engine instance, if any.
 *
 * The engine emits `engine_model_fallback` when a requested model is
 * unavailable and it runs with the configured default instead. The fact is
 * stored in `engineModelFallbacks` keyed by bare tabId (one fallback slot
 * per tab — the active instance at event time owns it). This pure resolver
 * maps a tab to its fallback so the tab pill (TabStripTabPill) and any test
 * can derive the desktop ⚠ indicator from the same logic, avoiding a
 * reimplemented derivation in the component vs. its test.
 *
 * Returns `null` when the tab has no pane, no active instance, or no
 * fallback recorded for that tab.
 */
export function resolveTabModelFallback(
  conversationPanes: Map<string, ConversationPane>,
  engineModelFallbacks: Map<string, TabModelFallback>,
  tabId: string,
): TabModelFallback | null {
  const inst = activeInstance(conversationPanes, tabId);
  if (!inst) return null;
  return engineModelFallbacks.get(tabId) ?? null;
}
