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
 * Used by `GroupPill` to replace the stacked StackedStatusDots layout with
 * a single representative dot.
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
