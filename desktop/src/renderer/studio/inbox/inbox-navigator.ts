import type { TabState } from '../../../shared/types'
import type { IntegrationMember, IntegrationWorkspace, WorktreeInfo, WorktreeInventoryEntry } from '../../../shared/types'
import { buildWorktreeList } from '../../../shared/worktree-list'
import { inboxProjectFor, type InboxProject } from './inbox-grouping'

export type InboxNavigatorGroupKind = 'bench' | 'source' | 'worktree'

export interface InboxNavigatorGroup {
  key: string
  kind: InboxNavigatorGroupKind
  label: string
  tabs: TabState[]
  worktree?: WorktreeInventoryEntry
  membership?: IntegrationMember
  workspace?: IntegrationWorkspace
}

export interface InboxNavigatorProject {
  project: InboxProject
  groups: InboxNavigatorGroup[]
  flatTabs: TabState[]
}

function containsDirectory(root: string, directory: string): boolean {
  return directory === root || directory.startsWith(`${root}/`)
}

function fallbackWorktree(info: WorktreeInfo): WorktreeInventoryEntry {
  return {
    worktreePath: info.worktreePath,
    branchName: info.branchName,
    sourceBranch: info.sourceBranch,
    label: info.worktreePath.split('/').filter(Boolean).at(-1) ?? info.branchName,
    head: '',
    lastCommitSubject: '',
    isDirty: false,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: false,
    landedAt: info.landedAt,
  }
}

function uniqueInventory(entries: readonly WorktreeInventoryEntry[]): WorktreeInventoryEntry[] {
  const byPath = new Map<string, WorktreeInventoryEntry>()
  for (const entry of entries) byPath.set(entry.worktreePath, entry)
  return [...byPath.values()]
}

function worktreeForTab(
  tab: TabState,
  entries: readonly WorktreeInventoryEntry[],
): WorktreeInventoryEntry | null {
  const explicit = tab.worktree
  if (explicit) {
    return entries.find((entry) => entry.worktreePath === explicit.worktreePath)
      ?? fallbackWorktree(explicit)
  }
  return entries
    .filter((entry) => containsDirectory(entry.worktreePath, tab.workingDirectory))
    .sort((left, right) => right.worktreePath.length - left.worktreePath.length)[0]
    ?? null
}

export function inboxNavigatorProjectFor(
  tab: TabState,
  benches: ReadonlyMap<string, readonly IntegrationWorkspace[]>,
  inventory: ReadonlyMap<string, readonly WorktreeInventoryEntry[]>,
): InboxProject {
  const direct = inboxProjectFor(tab, benches)
  if (tab.worktree || benches.has(direct.key) || inventory.has(direct.key)) return direct
  for (const [repoPath, entries] of inventory) {
    if (entries.some((entry) => containsDirectory(entry.worktreePath, tab.workingDirectory))) {
      return { key: repoPath, name: repoPath.split('/').filter(Boolean).at(-1) ?? repoPath }
    }
  }
  return direct
}

/**
 * Builds the Inbox tree from conversations, then enriches its location headers
 * with inventory and bench state. Inventory-backed non-landed worktrees appear
 * even when they have no conversations, so Inbox remains a complete workspace
 * navigator. The Bench is also structural and appears whenever it exists.
 */
export function buildInboxNavigator(
  tabs: readonly TabState[],
  benches: ReadonlyMap<string, readonly IntegrationWorkspace[]>,
  inventory: ReadonlyMap<string, readonly WorktreeInventoryEntry[]>,
  selectedBenchByRepo: ReadonlyMap<string, string> = new Map(),
  projectScope: string | null = null,
): InboxNavigatorProject[] {
  const projects = new Map<string, { project: InboxProject; tabs: TabState[] }>()
  for (const tab of tabs) {
    if (tab.isTerminalOnly) continue
    const project = inboxNavigatorProjectFor(tab, benches, inventory)
    if (projectScope && project.key !== projectScope) continue
    const current = projects.get(project.key)
    if (current) current.tabs.push(tab)
    else projects.set(project.key, { project, tabs: [tab] })
  }
  // Inventory is the source of truth for workspace presence. Include every
  // repo with a non-landed worktree before grouping conversation tabs.
  for (const [repoPath, entries] of inventory) {
    if (projectScope && repoPath !== projectScope) continue
    if (entries.some((entry) => entry.landedAt == null) && !projects.has(repoPath)) {
      projects.set(repoPath, { project: { key: repoPath, name: repoPath.split('/').filter(Boolean).at(-1) ?? repoPath }, tabs: [] })
    }
  }
  // A repo whose only open conversation is a bench terminal has no entry above
  // (terminal-only tabs are filtered before project assignment), but its Bench
  // is still a structural bucket that must be visible.
  for (const [repoPath, workspaces] of benches) {
    if (workspaces.length === 0) continue
    if (projectScope && repoPath !== projectScope) continue
    if (!projects.has(repoPath)) {
      projects.set(repoPath, { project: { key: repoPath, name: repoPath.split('/').filter(Boolean).at(-1) ?? repoPath }, tabs: [] })
    }
  }

  return [...projects.values()].map(({ project, tabs: projectTabs }) => {
    const entries = uniqueInventory(inventory.get(project.key) ?? [])
    const workspaces = benches.get(project.key) ?? []
    const membershipWorkspace = workspaces.find((workspace) => workspace.members.some((member) => entries.some((entry) => entry.worktreePath === member.worktreePath)))
    const activeWorkspace = workspaces.find((workspace) => workspace.sourceBranch === selectedBenchByRepo.get(project.key))
      ?? workspaces.find((workspace) => projectTabs.some((tab) => containsDirectory(workspace.benchPath, tab.workingDirectory)))
      ?? membershipWorkspace
      ?? workspaces[0]
    const { items } = buildWorktreeList(entries, workspaces, activeWorkspace?.sourceBranch ?? null)
    const itemByPath = new Map(items.map((item) => [item.entry.worktreePath, item]))
    const workspaceByPath = new Map(workspaces.map((workspace) => [workspace.benchPath, workspace]))

    // Three fixed bands, built as separate collections so the final order is
    // ALWAYS Bench, then worktrees, then Source Repository -- never the order
    // conversations happen to be encountered in. Interleaving them by
    // first-encounter (the previous approach, one shared map keyed on
    // whichever group a tab hit first) let Source Repository land in the
    // middle of the worktree list whenever a worktree conversation was more
    // recently active than the repo's own conversations.
    const benchGroups = new Map<string, InboxNavigatorGroup>()
    if (activeWorkspace) {
      const key = `bench:${activeWorkspace.benchPath}`
      benchGroups.set(key, {
        key,
        kind: 'bench',
        label: `Integration Bench · ${activeWorkspace.sourceBranch}`,
        tabs: [],
        workspace: activeWorkspace,
      })
    }
    const worktreeGroups = new Map<string, InboxNavigatorGroup>()
    let sourceGroup: InboxNavigatorGroup | null = null
    const flatTabs: TabState[] = []

    for (const tab of projectTabs) {
      const workspace = [...workspaceByPath.values()]
        .filter((candidate) => containsDirectory(candidate.benchPath, tab.workingDirectory))
        .sort((left, right) => right.benchPath.length - left.benchPath.length)[0]
      if (workspace) {
        const key = `bench:${workspace.benchPath}`
        const group = benchGroups.get(key) ?? {
          key,
          kind: 'bench' as const,
          label: `Integration Bench · ${workspace.sourceBranch}`,
          tabs: [],
          workspace,
        }
        group.tabs.push(tab)
        benchGroups.set(key, group)
        continue
      }

      const entry = worktreeForTab(tab, entries)
      if (entry) {
        const key = entry.worktreePath
        const item = itemByPath.get(key)
        const group = worktreeGroups.get(key) ?? {
          key,
          kind: 'worktree' as const,
          label: entry.title?.trim() || entry.label,
          tabs: [],
          worktree: entry,
          membership: item?.membership,
        }
        group.tabs.push(tab)
        worktreeGroups.set(key, group)
        continue
      }

      if (entries.length > 0 || workspaces.length > 0) {
        sourceGroup ??= { key: `source:${project.key}`, kind: 'source' as const, label: 'Source Repository', tabs: [] }
        sourceGroup.tabs.push(tab)
      } else {
        flatTabs.push(tab)
      }
    }

    for (const entry of entries) {
      if (entry.landedAt != null || worktreeGroups.has(entry.worktreePath)) continue
      const item = itemByPath.get(entry.worktreePath)
      worktreeGroups.set(entry.worktreePath, {
        key: entry.worktreePath,
        kind: 'worktree',
        label: entry.title?.trim() || entry.label || entry.branchName,
        tabs: [],
        worktree: entry,
        membership: item?.membership,
      })
    }
    const groups = [...benchGroups.values(), ...worktreeGroups.values(), ...(sourceGroup ? [sourceGroup] : [])]
    return { project, groups, flatTabs }
  }).sort((left, right) => left.project.name.localeCompare(right.project.name))
}
