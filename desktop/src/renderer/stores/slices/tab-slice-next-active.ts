/**
 * tab-slice-next-active — pure next-active-tab computation for closeTab.
 *
 * Extracted from tab-slice.ts (file-size cap), mirroring the session-busy-guard.ts
 * extraction pattern. The closeTab action calls {@link pickNextActiveTab} when
 * the tab being closed is the active one and at least one tab remains, to decide
 * which remaining tab to activate.
 *
 * ─── Why group-aware ─────────────────────────────────────────────────────────
 * The pre-fix selection picked the next tab by flat array index across ALL tabs
 * (`remaining[Math.min(closedIndex, remaining.length - 1)]`), ignoring tab
 * groups. Closing a tab inside a group could therefore jump the active selection
 * into an unrelated group. This helper prefers the nearest remaining sibling in
 * the SAME derived group (the tab after the closed one within the group, else the
 * tab before it), and only falls back to the nearest-by-flat-index choice when the
 * closed tab's group has no remaining siblings.
 *
 * ─── Group derivation (mirrors useTabGroups.ts) ──────────────────────────────
 * The grouping the user sees is derived, not stored on the tab as a single key:
 *   - mode 'off'    → every tab is its own flat list (no grouping); fall straight
 *                     through to nearest-by-flat-index.
 *   - mode 'auto'   → group key is the tab's workingDirectory (default '~').
 *                     (useTabGroups renders single-tab dirs as ungrouped pills, but
 *                     for next-active purposes a same-directory sibling is still the
 *                     most sensible landing spot, so we group by directory uniformly.)
 *   - mode 'manual' → group key is the tab's groupId, falling back to the default
 *                     group's id when the tab has no groupId or an unknown groupId
 *                     (matches buildManualGroups' "tabs without a groupId go to the
 *                     default group" rule).
 *
 * Pure: no store access, no side effects. The caller commits the tab removal and
 * routes activation of the returned id through the selectTab action.
 */

import type { TabState, TabGroup, TabGroupMode } from '../../../shared/types'

/** Minimal group context the helper needs to derive group membership. */
export interface NextActiveGroupContext {
  /** Active tab-group mode. */
  mode: TabGroupMode
  /** Effective manual tab groups (already expanded to include defaults). Only read in 'manual' mode. */
  groups: TabGroup[]
}

/**
 * Derive the group key for a tab under the given mode. Returns null in 'off'
 * mode (no grouping). Mirrors the keys useTabGroups builds.
 */
function groupKeyFor(tab: TabState, ctx: NextActiveGroupContext): string | null {
  if (ctx.mode === 'off') return null
  if (ctx.mode === 'auto') return tab.workingDirectory || '~'
  // manual: groupId, falling back to the default group's id (buildManualGroups
  // routes tabs without a known groupId to the default group).
  const defaultGroup = ctx.groups.find((g) => g.isDefault) || ctx.groups[0]
  if (tab.groupId && ctx.groups.some((g) => g.id === tab.groupId)) return tab.groupId
  return defaultGroup ? defaultGroup.id : null
}

/**
 * Pick which remaining tab to activate after closing `closingTabId`.
 *
 * @param closingTabId  id of the tab being closed (the currently-active tab).
 * @param tabsBeforeClose  the full tab list BEFORE the close is committed (so
 *                         positional adjacency is computed against the original
 *                         order the user saw).
 * @param ctx  group context (mode + effective manual groups).
 * @returns the id of the tab to activate, or null when no tab remains.
 *
 * Selection order:
 *   1. Nearest remaining sibling in the closed tab's derived group — the tab
 *      AFTER the closed one within the group, else the tab BEFORE it.
 *   2. Fallback (group emptied, or mode 'off'): nearest-by-flat-index across all
 *      remaining tabs — `remaining[min(closedIndex, remaining.length - 1)]`,
 *      preserving the prior behavior so we still land on a real adjacent tab.
 */
export function pickNextActiveTab(
  closingTabId: string,
  tabsBeforeClose: TabState[],
  ctx: NextActiveGroupContext,
): string | null {
  const closedIndex = tabsBeforeClose.findIndex((t) => t.id === closingTabId)
  if (closedIndex === -1) return null

  const remaining = tabsBeforeClose.filter((t) => t.id !== closingTabId)
  if (remaining.length === 0) return null

  // 1. In-group sibling. Only attempt when grouping is on.
  if (ctx.mode !== 'off') {
    const closingTab = tabsBeforeClose[closedIndex]
    const closedKey = groupKeyFor(closingTab, ctx)
    if (closedKey !== null) {
      // Walk forward from the closed position for the next same-group tab,
      // then backward, using the ORIGINAL order so adjacency matches what the
      // user saw in the strip.
      for (let i = closedIndex + 1; i < tabsBeforeClose.length; i++) {
        const t = tabsBeforeClose[i]
        if (t.id !== closingTabId && groupKeyFor(t, ctx) === closedKey) return t.id
      }
      for (let i = closedIndex - 1; i >= 0; i--) {
        const t = tabsBeforeClose[i]
        if (t.id !== closingTabId && groupKeyFor(t, ctx) === closedKey) return t.id
      }
      // Group emptied — fall through to flat fallback below.
    }
  }

  // 2. Nearest-by-flat-index fallback (prior behavior).
  return remaining[Math.min(closedIndex, remaining.length - 1)].id
}
