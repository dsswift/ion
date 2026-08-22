/**
 * Select next active tab after closing an active tab.
 *
 * Closing worktree conversations must stay local whenever possible. Positional
 * adjacency and user tab groups are presentation concerns; neither expresses
 * which conversation the operator last used. This selector instead works from
 * stable worktree identity plus visit MRU.
 */

import type { TabState } from '../../../shared/types'

export type NextActiveTier =
  | 'same-worktree'
  | 'same-worktree-source'
  | 'same-base-directory'
  | 'outside-base-directory'
  | 'terminal-fallback'

export interface NextActiveTabSelection {
  tabId: string
  tier: NextActiveTier
  lastVisitedAt: number | null
  lastActivityAt: number | null
}

function baseDirectoryFor(tab: TabState): string {
  return tab.worktree?.repoPath ?? tab.workingDirectory
}

function sharesBaseDirectoryChain(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
}

/**
 * Compares visit MRU without letting engine activity rewrite user navigation
 * history. Legacy and never-visited tabs use genuine activity only after all
 * visited candidates have been considered. Original tab order breaks ties,
 * making the result stable rather than dependent on engine timing.
 */
function mostRecentlyVisited(tabs: TabState[]): TabState | null {
  let selected: TabState | null = null
  for (const tab of tabs) {
    if (!selected) {
      selected = tab
      continue
    }

    const selectedVisited = selected.lastVisitedAt
    const candidateVisited = tab.lastVisitedAt
    if (candidateVisited != null && selectedVisited == null) {
      selected = tab
      continue
    }
    if (candidateVisited == null && selectedVisited != null) continue

    if (candidateVisited != null && selectedVisited != null) {
      if (candidateVisited > selectedVisited) selected = tab
      continue
    }

    const candidateActivity = tab.lastActivityAt ?? 0
    const selectedActivity = selected.lastActivityAt ?? 0
    if (candidateActivity > selectedActivity) selected = tab
  }
  return selected
}

function selection(tab: TabState, tier: NextActiveTier): NextActiveTabSelection {
  return {
    tabId: tab.id,
    tier,
    lastVisitedAt: tab.lastVisitedAt,
    lastActivityAt: tab.lastActivityAt,
  }
}

/**
 * Pick next active tab from complete pre-close list.
 *
 * Conversation selection tiers, in order:
 *  1. same managed worktree;
 *  2. another managed worktree cut from same repo/source branch;
 *  3. same source checkout/base directory;
 *  4. conversation outside that base directory.
 *
 * Terminal-only tabs cannot displace a conversation. They are considered only
 * after every conversation is gone, then use MRU across the remaining terminal
 * tabs. `null` means the caller must create its replacement blank conversation.
 */
export function pickNextActiveTab(
  closingTabId: string,
  tabsBeforeClose: TabState[],
): NextActiveTabSelection | null {
  const closingTab = tabsBeforeClose.find((tab) => tab.id === closingTabId)
  if (!closingTab) return null

  const remaining = tabsBeforeClose.filter((tab) => tab.id !== closingTabId)
  const conversations = remaining.filter((tab) => !tab.isTerminalOnly)
  if (conversations.length === 0) {
    const terminal = mostRecentlyVisited(remaining.filter((tab) => tab.isTerminalOnly))
    return terminal ? selection(terminal, 'terminal-fallback') : null
  }

  const closingWorktree = closingTab.worktree
  const closingBase = baseDirectoryFor(closingTab)
  const tiers: Array<{ tier: Exclude<NextActiveTier, 'terminal-fallback'>; matches: (tab: TabState) => boolean }> = [
    {
      tier: 'same-worktree',
      matches: (tab) => !!closingWorktree && tab.worktree?.worktreePath === closingWorktree.worktreePath,
    },
    {
      tier: 'same-worktree-source',
      matches: (tab) => !!closingWorktree
        && !!tab.worktree
        && tab.worktree.worktreePath !== closingWorktree.worktreePath
        && tab.worktree.repoPath === closingWorktree.repoPath
        && tab.worktree.sourceBranch === closingWorktree.sourceBranch,
    },
    {
      tier: 'same-base-directory',
      matches: (tab) => sharesBaseDirectoryChain(baseDirectoryFor(tab), closingBase),
    },
    {
      tier: 'outside-base-directory',
      matches: (tab) => !sharesBaseDirectoryChain(baseDirectoryFor(tab), closingBase),
    },
  ]

  for (const tier of tiers) {
    const tab = mostRecentlyVisited(conversations.filter(tier.matches))
    if (tab) return selection(tab, tier.tier)
  }

  return null
}
