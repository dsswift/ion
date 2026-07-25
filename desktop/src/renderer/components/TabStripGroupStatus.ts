// ─── Group-level status derivation ─────────────────────────────────────────
//
// Extracted from TabStripShared.ts to keep that file under the 600-line cap
// (AGENTS.md → "When a file exceeds the cap"). The logic lives here; the
// canonical import path is TabStripShared.ts which re-exports
// `getGroupStatusColor`. Do not import from this file directly in components.
//
// Priority constants mirror the inline literals in `getTabStatusColor`
// (TabStripShared.ts). Both must be updated together if the cascade changes.
// One-way dependency: this file imports from TabStripShared; TabStripShared
// re-exports from here. No circular dependency.

import type { TabState } from '../../shared/types'
import type { useColors } from '../theme'
import { getTabStatusColor } from './TabStripShared'

// ─── Dot-model type ───────────────────────────────────────────────────────────
//
// `GroupDotModel` is the discriminated union the group pill renders from.
//
//   'single'  — one dot; used for inactive groups or single-tab groups.
//   'stack'   — two overlapping dots; foreground = selected tab's own status,
//               background = aggregate of all other tabs. Only for active
//               multi-tab groups, where the single aggregate dot hides the
//               selected conversation's actual state.

type DotAttrs = { bg: string; pulse: boolean; glow: boolean; glowColor: string }

export type GroupDotModel =
  | { kind: 'single'; dot: DotAttrs }
  | { kind: 'stack'; foreground: DotAttrs; background: DotAttrs }

// ─── Priority constants ───────────────────────────────────────────────────────
//
// Exported so tests can assert specific priority levels without hardcoding
// magic numbers. `getTabStatusColor` uses the same values inlined as numeric
// literals to avoid the circular import that would arise if TabStripShared
// imported from here.
//
//   8 = error            (dead/failed — red)
//   7 = permission       (orange glow, blocked)
//   6 = running          (orange pulse, foreground active)
//   5 = running-children (yellow pulse, background agents)
//   4 = plan-ready       (green glow, waiting on user)
//   3 = question         (blue glow, waiting on user)
//   2 = bash             (amber pulse/glow, executing shell)
//   1 = unread           (green, notification)
//   0 = idle             (gray, no activity)

export const STATUS_PRIORITY_ERROR       = 8
export const STATUS_PRIORITY_PERMISSION  = 7
export const STATUS_PRIORITY_RUNNING     = 6
export const STATUS_PRIORITY_CHILDREN    = 5
export const STATUS_PRIORITY_PLAN_READY  = 4
export const STATUS_PRIORITY_QUESTION    = 3
export const STATUS_PRIORITY_BASH        = 2
export const STATUS_PRIORITY_UNREAD      = 1
export const STATUS_PRIORITY_IDLE        = 0

/**
 * Derive the highest-priority status dot for a group of tabs.
 *
 * Folds `getTabStatusColor` across all non-terminal tabs in the group,
 * returns the result with the highest `priority` value. When the group is
 * empty or all tabs are terminal-only, returns an idle dot. This is the
 * single source of truth for the group pill's status indicator — it shares
 * the same 9-level cascade as the per-tab dot, so desktop and iOS can both
 * derive the same answer from the same ranked list.
 *
 * Imported and re-exported by TabStripShared.ts — consumers should import
 * from there, not from this module.
 */
export function getGroupStatusColor(
  tabs: TabState[],
  colors: ReturnType<typeof useColors>,
): { bg: string; pulse: boolean; glow: boolean; glowColor: string } {
  const conversationTabs = tabs.filter((t) => !t.isTerminalOnly)
  let best: { bg: string; pulse: boolean; glow: boolean; glowColor: string; priority: number } = {
    bg: colors.statusIdle,
    pulse: false,
    glow: false,
    glowColor: colors.statusPermissionGlow,
    priority: STATUS_PRIORITY_IDLE,
  }
  for (const tab of conversationTabs) {
    const result = getTabStatusColor(tab, colors)
    if (result.priority > best.priority) best = result
  }
  return { bg: best.bg, pulse: best.pulse, glow: best.glow, glowColor: best.glowColor }
}

/**
 * Decide which dot model to render for a group pill.
 *
 * For an **active** group with **more than one tab**, the single aggregate dot
 * hides the selected conversation's own status (e.g. the group pulses orange
 * because a background tab is running, even though the tab in focus is idle).
 * In this case we return `kind: 'stack'`:
 *   - `foreground` = the selected tab's own status dot (via `getTabStatusColor`)
 *   - `background` = the aggregate of every *other* tab (via `getGroupStatusColor`)
 *
 * For an inactive group, or a single-tab group, the distinction is meaningless
 * (no "selected tab in focus" concept, or the aggregate equals the single tab),
 * so we return `kind: 'single'` with the full aggregate as usual.
 *
 * Pure function — the `colors` object is a theme snapshot; no store reads here.
 * Tests can call it without a React environment.
 */
export function getGroupDotModel(
  tabs: TabState[],
  selectedTabId: string | null,
  isActive: boolean,
  colors: ReturnType<typeof useColors>,
): GroupDotModel {
  const conversationTabs = tabs.filter((t) => !t.isTerminalOnly)

  // Single aggregate for inactive groups or single-tab groups.
  if (!isActive || conversationTabs.length <= 1) {
    return { kind: 'single', dot: getGroupStatusColor(tabs, colors) }
  }

  // Active multi-tab group: split foreground (selected) from background (others).
  const selectedTab = conversationTabs.find((t) => t.id === selectedTabId) ?? conversationTabs[0]
  const otherTabs   = tabs.filter((t) => t.id !== selectedTab.id)

  const foreground = getTabStatusColor(selectedTab, colors)
  const background = getGroupStatusColor(otherTabs, colors)

  return {
    kind: 'stack',
    foreground: { bg: foreground.bg, pulse: foreground.pulse, glow: foreground.glow, glowColor: foreground.glowColor },
    background,
  }
}
