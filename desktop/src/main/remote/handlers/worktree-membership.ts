import type { IntegrationWorkspace } from '../../../shared/types'
import type { RemoteMembership } from '../protocol'

/** Convert one persisted integration member to the desktop-to-iOS wire shape. */
export function projectWorktreeMembership(
  member: IntegrationWorkspace['members'][number],
  sourceBranch: string,
  order: number,
): RemoteMembership {
  return {
    sourceBranch,
    pin: member.pin,
    merge: member.merge,
    pinnedSha: member.pinnedSha,
    order,
    conflictPaths: member.conflictPaths,
    conflictsWith: member.conflictsWith,
    mergeResolution: member.mergeResolution,
  }
}
