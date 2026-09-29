/**
 * clone-fixes — how the transfer checklist offers to clone a repository the
 * destination does not have.
 *
 * A clone is someone else's code, and Ion runs none of it until the
 * operator trusts the project. When the repository declares code to run
 * (its setup, its worktree builds), the clone is the moment to ask: the
 * operator is already saying "put it there", so the row offers to trust it
 * in the same click and names exactly what that runs. The source read
 * those commands from its own checkout, so they are known before anything
 * is cloned. A repository that declares nothing gets the plain verb.
 */
import type { DeclaredProvisioning } from '@ion/shared/types-environment-admin'
import type { TransferFix } from './useTransferPreflight'

export function cloneFixes(
  provisioning: DeclaredProvisioning | undefined,
  /** Clones on the destination; `trust` registers it trusted and runs its setup when it lands. */
  clone: (trust: boolean) => Promise<void>,
): TransferFix[] {
  if (!provisioning) return [{ label: 'Clone it there', run: () => clone(false) }]
  return [
    { label: 'Clone and trust', run: () => clone(true) },
    { label: 'Clone only', run: () => clone(false) },
  ]
}

/** The sentence that says what "Clone and trust" runs, or empty when nothing is declared. */
export function cloneTrustDetail(provisioning: DeclaredProvisioning | undefined): string {
  if (!provisioning) return ''
  const builds = provisioning.builds.join(', ')
  const runs = provisioning.setup && builds
    ? `runs its setup, ${provisioning.setup}, as soon as it lands, and lets its worktrees run ${builds}`
    : provisioning.setup
      ? `runs its setup, ${provisioning.setup}, as soon as it lands`
      : `lets its worktrees run ${builds}`
  return `Clone and trust ${runs}. Clone only runs none of its code.`
}
