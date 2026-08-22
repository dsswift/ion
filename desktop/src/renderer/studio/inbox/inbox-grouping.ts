import type { IntegrationWorkspace, TabState, WorktreeInventoryEntry } from '../../../shared/types'

export interface InboxProject {
  key: string
  name: string
}

export interface InboxWorktree {
  key: string
  /** Directory-style group title, e.g. ion-6d15c16e. */
  label: string
  /** Short stable machine identity, e.g. 6d15c16e. */
  hash: string | null
  isSource: boolean
}

export interface InboxProjectGroup {
  project: InboxProject
  worktrees: Array<{ worktree: InboxWorktree; tabs: TabState[] }>
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function benchFor(tab: TabState, benches: ReadonlyMap<string, readonly IntegrationWorkspace[]>): IntegrationWorkspace | null {
  for (const workspaces of benches.values()) {
    const match = workspaces.find((workspace) =>
      tab.workingDirectory === workspace.benchPath || tab.workingDirectory.startsWith(`${workspace.benchPath}/`),
    )
    if (match) return match
  }
  return null
}

/**
 * Identifies the repository a conversation belongs to. Worktrees and benches
 * use their registered source repository, never their generated directory name.
 */
export function inboxProjectFor(tab: TabState, benches: ReadonlyMap<string, readonly IntegrationWorkspace[]>): InboxProject {
  const bench = benchFor(tab, benches)
  const key = tab.worktree?.repoPath ?? bench?.repoPath ?? tab.workingDirectory
  return { key, name: baseName(key) }
}

/** The second inbox order key. Each source repository remains its own group. */
export function inboxWorktreeFor(
  tab: TabState,
  benches: ReadonlyMap<string, readonly IntegrationWorkspace[]>,
  inventory: ReadonlyMap<string, readonly WorktreeInventoryEntry[]> = new Map(),
): InboxWorktree {
  if (tab.worktree) {
    const entry = inventory.get(tab.worktree.repoPath)?.find((candidate) => candidate.worktreePath === tab.worktree!.worktreePath)
    const slug = baseName(tab.worktree.worktreePath)
    const hash = slug.match(/-([0-9a-f]{6,})$/i)?.[1] ?? null
    return { key: tab.worktree.worktreePath, label: entry?.title?.trim() || entry?.label || tab.worktree.branchName || slug, hash, isSource: false }
  }
  const bench = benchFor(tab, benches)
  if (bench) {
    return { key: bench.benchPath, label: `Integration · ${bench.sourceBranch}`, hash: null, isSource: false }
  }
  return { key: tab.workingDirectory, label: 'Source repository', hash: null, isSource: true }
}

/** Groups already-sorted conversations by repository, then worktree. */
export function groupInboxTabs(
  tabs: readonly TabState[],
  benches: ReadonlyMap<string, readonly IntegrationWorkspace[]>,
  inventory: ReadonlyMap<string, readonly WorktreeInventoryEntry[]> = new Map(),
): InboxProjectGroup[] {
  const projects = new Map<string, InboxProjectGroup>()
  for (const tab of tabs) {
    const project = inboxProjectFor(tab, benches)
    const worktree = inboxWorktreeFor(tab, benches, inventory)
    let projectGroup = projects.get(project.key)
    if (!projectGroup) {
      projectGroup = { project, worktrees: [] }
      projects.set(project.key, projectGroup)
    }
    let worktreeGroup = projectGroup.worktrees.find((candidate) => candidate.worktree.key === worktree.key)
    if (!worktreeGroup) {
      worktreeGroup = { worktree, tabs: [] }
      projectGroup.worktrees.push(worktreeGroup)
    }
    worktreeGroup.tabs.push(tab)
  }
  return [...projects.values()].sort((left, right) => left.project.name.localeCompare(right.project.name)).map((group) => ({
    ...group,
    worktrees: [...group.worktrees].sort((left, right) => {
      if (left.worktree.isSource !== right.worktree.isSource) return left.worktree.isSource ? -1 : 1
      return left.worktree.label.localeCompare(right.worktree.label)
    }),
  }))
}
