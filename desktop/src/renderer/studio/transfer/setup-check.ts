/**
 * setup-check — the one setup row a transfer can show, and when it may.
 *
 * Ion cannot know whether someone ran a project's setup by hand. It can
 * only know two things for certain: whether the project declares a setup
 * command, and whether it is a checkout Ion cloned that the operator has
 * not trusted yet. So the row appears for exactly that project — a fresh
 * clone, usually made by this very transfer — and never for a checkout the
 * operator already works in. It names the exact command, and nothing runs
 * until the operator presses the button: trusting the project is what lets
 * Ion run its code at all.
 */
import type { EnvironmentProject } from '@ion/shared/types-environment-admin'
import type { TransferCheck } from './useTransferPreflight'

export function setupCheck(
  project: EnvironmentProject | undefined,
  /** Trusts the project, then runs its declared setup when it has one. */
  trustAndSetup: (project: EnvironmentProject) => Promise<void>,
): TransferCheck | null {
  if (!project || project.trusted !== false) return null
  const command = project.setupCommand
  return {
    id: 'setup',
    state: 'info',
    label: command ? `${project.displayName} declares a setup: ${command}` : `Ion cloned ${project.displayName}`,
    detail: command
      ? 'Ion runs none of its code until you trust it. The conversation moves either way.'
      : 'Ion runs none of its code until you trust it, including when a worktree of it is made.',
    fixes: [{ label: command ? 'Trust and run setup' : 'Trust project', run: () => trustAndSetup(project) }],
  }
}
