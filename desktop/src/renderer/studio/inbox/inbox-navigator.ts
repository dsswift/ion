import type { TabState } from '@ion/shared/types'
import type { IntegrationMember, IntegrationWorkspace, WorktreeInfo, WorktreeInventoryEntry } from '@ion/shared/types'
import { buildWorktreeList } from '@ion/shared/worktree-list'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { inboxProjectFor, type InboxProject } from './inbox-grouping'
import { checkoutSlot, environmentScopedKey, pathScope, type ProjectScopeResolver } from './project-identity'
import { pathBasename } from '@ion/shared/paths'

export type InboxNavigatorGroupKind = 'bench' | 'source' | 'worktree'

export interface InboxNavigatorGroup {
  key: string
  kind: InboxNavigatorGroupKind
  label: string
  tabs: TabState[]
  worktree?: WorktreeInventoryEntry
  membership?: IntegrationMember
  workspace?: IntegrationWorkspace
  /** The Environment this group's checkout is on, when it is not the header's own. */
  environmentId?: string
}

export interface InboxNavigatorProject {
  /**
   * The primary checkout: the path key structure is indexed by (inventory,
   * benches, collapse state). When the repository is open on several
   * environments this is the local one, else the first.
   */
  project: InboxProject
  /** The Environment `project.key` is a path on: the primary checkout's machine. A verb started from the header (a new conversation in the project) runs there. */
  environmentId: string
  /** The repository identity this header stands for; equal to `project.key` for a checkout with no known identity. See `project-identity.ts`. */
  scopeKey: string
  /** Every checkout merged under this header, each a path key on its own Environment. A re-read of a checkout's worktrees runs there. */
  checkouts: Array<{ environmentId: string; key: string }>
  groups: InboxNavigatorGroup[]
  flatTabs: TabState[]
}

export interface InboxNavigatorOptions {
  /** Maps a path key on an environment to its repository identity. Defaults to every path being its own project. */
  scopeOf?: ProjectScopeResolver
  /** Names an environment, to label the groups of a checkout that is not the header's primary one. */
  environmentLabel?: (environmentId: string) => string
  /**
   * The Environment whose worktree read model holds `repoPath`. The merged
   * inventory and bench maps do not say which machine a key came from, and a
   * repository known only from them (no conversation open in it) is a
   * checkout on that machine. Defaults to local.
   */
  environmentOfRepo?: (repoPath: string) => string | null
  /**
   * Whether the Environment filter shows this machine. Conversations arrive
   * already filtered; a repository known only from the worktree read model
   * does not, so it is checked here. Defaults to every machine.
   */
  environmentIncluded?: (environmentId: string) => boolean
  /**
   * Whether worktrees are a developer surface on offer for this machine's
   * conversations. Where they are not, its conversations are listed flat
   * under their repository, with no worktree, bench, or source grouping.
   * Defaults to offered.
   */
  worktreesOffered?: (environmentId: string) => boolean
}

/**
 * The identity of a project header among the navigator's rows: its React key
 * and its collapse key. `project.key` alone is a path, and two environments
 * can each have a project at the same path.
 */
export function inboxProjectRowKey(node: Pick<InboxNavigatorProject, 'project' | 'environmentId'>): string {
  return `project:${environmentScopedKey(node.environmentId, node.project.key)}`
}

/**
 * The identity of a group header among the navigator's rows: its React key
 * and its collapse key. `group.key` alone is a path, and a header can hold
 * the same path once per environment.
 */
export function inboxGroupRowKey(node: Pick<InboxNavigatorProject, 'environmentId'>, group: Pick<InboxNavigatorGroup, 'key' | 'environmentId'>, variant: 'card' | 'slim'): string {
  return `group:${variant}:${environmentScopedKey(group.environmentId ?? node.environmentId, group.key)}`
}

function containsDirectory(root: string, directory: string): boolean {
  return directory === root || directory.startsWith(`${root}/`)
}

function fallbackWorktree(info: WorktreeInfo): WorktreeInventoryEntry {
  return {
    worktreePath: info.worktreePath,
    branchName: info.branchName,
    sourceBranch: info.sourceBranch,
    label: pathBasename(info.worktreePath) || info.branchName,
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
  projectScope: ReadonlySet<string> = new Set(),
  options: InboxNavigatorOptions = {},
): InboxNavigatorProject[] {
  const scopeOf = options.scopeOf ?? pathScope
  // The scope is a set of repository identities; a path key is still honored
  // so a selection made before identities were known keeps working until
  // the sidebar normalizes it.
  const projectIncluded = (scopeKey: string, projectKey: string): boolean => projectScope.size === 0 || projectScope.has(scopeKey) || projectScope.has(projectKey)
  const projects = new Map<string, { project: InboxProject; tabs: TabState[]; environmentId: string; scopeKey: string }>()
  for (const tab of tabs) {
    if (tab.isTerminalOnly) continue
    const project = inboxNavigatorProjectFor(tab, benches, inventory)
    const environmentId = tab.environmentId ?? LOCAL_ENVIRONMENT_ID
    const scopeKey = scopeOf(project.key, environmentId)
    if (!projectIncluded(scopeKey, project.key)) continue
    // Two environments can hold a checkout at the same path; they are
    // different checkouts, so the structural slot is per environment.
    const slot = checkoutSlot(environmentId, project.key)
    const current = projects.get(slot)
    if (current) current.tabs.push(tab)
    else projects.set(slot, { project, tabs: [tab], environmentId, scopeKey })
  }
  // A repository known only from the read model is a checkout on the
  // Environment that published it, never assumed local: a remote repository
  // placed in a local slot would take the header and draw its worktrees twice.
  const addStructural = (repoPath: string): void => {
    const environmentId = options.environmentOfRepo?.(repoPath) ?? LOCAL_ENVIRONMENT_ID
    if (options.environmentIncluded && !options.environmentIncluded(environmentId)) return
    const scopeKey = scopeOf(repoPath, environmentId)
    if (!projectIncluded(scopeKey, repoPath)) return
    const slot = checkoutSlot(environmentId, repoPath)
    if (projects.has(slot)) return
    projects.set(slot, { project: { key: repoPath, name: repoPath.split('/').filter(Boolean).at(-1) ?? repoPath }, tabs: [], environmentId, scopeKey })
  }
  // Inventory is the source of truth for workspace presence. Include every
  // repo with a non-landed worktree before grouping conversation tabs.
  for (const [repoPath, entries] of inventory) {
    if (entries.some((entry) => entry.landedAt == null)) addStructural(repoPath)
  }
  // A repo whose only open conversation is a bench terminal has no entry above
  // (terminal-only tabs are filtered before project assignment), but its Bench
  // is still a structural bucket that must be visible.
  for (const [repoPath, workspaces] of benches) {
    if (workspaces.length > 0) addStructural(repoPath)
  }

  const perCheckout = [...projects.values()].map(({ project, tabs: projectTabs, environmentId, scopeKey }) => {
    if (options.worktreesOffered && !options.worktreesOffered(environmentId)) {
      return { project, scopeKey, checkouts: [{ environmentId, key: project.key }], groups: [] as InboxNavigatorGroup[], flatTabs: [...projectTabs], environmentId }
    }
    // The read model is keyed by path with no machine, and holds one
    // machine's rows per path. A checkout on any other machine at that path
    // has no rows there: borrowing them would draw another machine's
    // worktrees and bench under this checkout.
    const ownsReadModel = (options.environmentOfRepo?.(project.key) ?? LOCAL_ENVIRONMENT_ID) === environmentId
    const entries = ownsReadModel ? uniqueInventory(inventory.get(project.key) ?? []) : []
    const workspaces = ownsReadModel ? benches.get(project.key) ?? [] : []
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
    // Conversations in the source checkout itself. Whether they earn the
    // Source Repository band is decided below, once every band that could sit
    // beside it is known.
    const checkoutTabs: TabState[] = []

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

      checkoutTabs.push(tab)
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
    // Bench membership is the primary worktree order. Members stay together at
    // the top in the exact sequence assembly uses. The stable sort preserves the
    // selected Inbox order for every worktree that is not in the active bench.
    const memberOrder = new Map(activeWorkspace?.members.map((member, index) => [member.worktreePath, index]) ?? [])
    const orderedWorktreeGroups = [...worktreeGroups.values()].sort((left, right) => {
      const leftOrder = memberOrder.get(left.key)
      const rightOrder = memberOrder.get(right.key)
      if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder
      if (leftOrder !== undefined) return -1
      if (rightOrder !== undefined) return 1
      return 0
    })
    // The Source Repository band exists to set the checkout's own conversations
    // apart from a bench or worktree band. It is earned only when one of those
    // bands renders: a project whose inventory holds nothing but landed
    // worktrees has no such band, so its conversations stay flat.
    const hasSiblingBand = benchGroups.size > 0 || orderedWorktreeGroups.length > 0
    const sourceGroup: InboxNavigatorGroup | null = hasSiblingBand && checkoutTabs.length > 0
      ? { key: `source:${project.key}`, kind: 'source', label: 'Source Repository', tabs: checkoutTabs }
      : null
    const flatTabs = hasSiblingBand ? [] : checkoutTabs
    const groups = [...benchGroups.values(), ...orderedWorktreeGroups, ...(sourceGroup ? [sourceGroup] : [])]
    return { project, scopeKey, checkouts: [{ environmentId, key: project.key }], groups, flatTabs, environmentId }
  })

  // One header per repository. Checkouts of the same repository on several
  // environments merge under the local one (else the first); the others'
  // groups follow, labeled with their machine so "Source Repository" twice
  // reads as two places rather than a duplicate.
  const merged = new Map<string, InboxNavigatorProject>()
  for (const node of perCheckout.sort((left, right) => Number(right.environmentId === LOCAL_ENVIRONMENT_ID) - Number(left.environmentId === LOCAL_ENVIRONMENT_ID))) {
    const primary = merged.get(node.scopeKey)
    if (!primary) { merged.set(node.scopeKey, node); continue }
    const machine = options.environmentLabel?.(node.environmentId) ?? node.environmentId
    primary.groups.push(...node.groups.map((group) => ({ ...group, label: `${group.label} · ${machine}`, environmentId: node.environmentId })))
    primary.flatTabs.push(...node.flatTabs)
    primary.checkouts.push(...node.checkouts)
  }
  return [...merged.values()]
    .sort((left, right) => left.project.name.localeCompare(right.project.name))
}
