/**
 * project-identity — which repository a checkout path is, across machines.
 *
 * The Inbox files a conversation under its checkout path, and that path is
 * a structural key: the worktree inventory and the benches are indexed by
 * it, and they really are per checkout. But a path is not a project. The
 * same repository cloned on two environments has two paths, and keying the
 * project scope and the project header on the path showed one project
 * twice and let a scope filter on one copy hide the other's conversations.
 *
 * So there are two keys. The path key stays where structure needs it; the
 * scope key is the repository identity (`remote:<host/org/repo>`, from each
 * environment's own project listing) and is what the scope menu, the scope
 * filter, and the project header group on. A checkout with no known
 * identity (no origin, or not a registered project) keeps its path as its
 * scope key, so it is its own project exactly as before.
 */
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { ProjectsByEnvironment } from '../connection/environment-projects'
import type { InboxProjectSelection } from './project-selection'

/** Maps a path key on an environment to its scope key. */
export type ProjectScopeResolver = (projectKey: string, environmentId: string) => string

/** Every path is its own project: the resolver used before any environment has answered. */
export const pathScope: ProjectScopeResolver = (projectKey) => projectKey

const SCOPE_PREFIX = 'remote:'

/** One checkout: an environment and a path on it. Built and looked up whole, never split. */
export function checkoutSlot(environmentId: string, projectKey: string): string {
  return `${environmentId}::${projectKey}`
}

export function buildProjectScopeResolver(byEnvironment: ProjectsByEnvironment): ProjectScopeResolver {
  const bySlot = new Map<string, string>()
  for (const [environmentId, projects] of Object.entries(byEnvironment)) {
    for (const project of projects) {
      if (project.entry.repoRemote) bySlot.set(checkoutSlot(environmentId, project.dir), `${SCOPE_PREFIX}${project.entry.repoRemote}`)
    }
  }
  return (projectKey, environmentId) => bySlot.get(checkoutSlot(environmentId, projectKey)) ?? projectKey
}

/**
 * Rewrites a stored selection made of path keys into scope keys, so a
 * filter saved before identities existed (or before an environment
 * answered) selects the whole project rather than one machine's copy. A
 * path is looked up on the local environment first, then on every other.
 * Returns the same set when nothing changes.
 */
export function normalizeProjectSelection(selection: InboxProjectSelection, byEnvironment: ProjectsByEnvironment): InboxProjectSelection {
  if (selection.size === 0) return selection
  const resolve = buildProjectScopeResolver(byEnvironment)
  const environments = [LOCAL_ENVIRONMENT_ID, ...Object.keys(byEnvironment).filter((id) => id !== LOCAL_ENVIRONMENT_ID)]
  let changed = false
  const next = new Set<string>()
  for (const key of selection) {
    let scope = key
    if (!key.startsWith(SCOPE_PREFIX)) {
      for (const environmentId of environments) {
        const candidate = resolve(key, environmentId)
        if (candidate !== key) { scope = candidate; break }
      }
    }
    if (scope !== key) changed = true
    next.add(scope)
  }
  return changed ? next : selection
}
