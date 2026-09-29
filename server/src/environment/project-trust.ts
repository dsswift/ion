/**
 * environment/project-trust — whether Ion may run a project's own code.
 *
 * A checkout Ion cloned is someone else's code until the operator trusts
 * it, so its setup command and its worktree seed builds do not run. Every
 * project the operator registered themselves is their own code, and a
 * directory that is no registered project is theirs too; both are trusted.
 *
 * A leaf module on purpose: worktree provisioning asks this, and must not
 * pull the project registry's writers (and everything they broadcast
 * through) in with it.
 */
import type { ProjectRegistry } from '@ion/shared/project-registry'
import { normalizeProjectDir } from '@ion/shared/project-registry'
import { readSettings } from '../persistence/settings-store'

export function isProjectTrusted(dirInput: string): boolean {
  const raw = readSettings().projects
  const registry = raw && typeof raw === 'object' ? (raw as ProjectRegistry) : {}
  return registry[normalizeProjectDir(dirInput)]?.trusted !== false
}

/** Refused because the project's code has not been trusted to run here. */
export class ProjectUntrustedError extends Error {
  readonly code = 'untrusted'
  constructor(dir: string) {
    super(`${dir} was cloned by Ion and is not trusted yet. Trust the project before Ion runs its code.`)
  }
}
