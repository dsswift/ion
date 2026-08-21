/** Pure member-set transform for an already-validated overlap recommendation. */
import type { IntegrationMember } from '../../shared/types'

export function applyRecommendationMembers(
  existing: IntegrationMember[],
  orderedPaths: string[],
  additions: IntegrationMember[],
): { members: IntegrationMember[]; removed: number; reordered: number } {
  const selected = new Set(orderedPaths)
  if (selected.size !== orderedPaths.length) throw new Error('Duplicate worktree paths cannot be applied.')
  const existingPaths = new Set(existing.map((member) => member.worktreePath))
  if (existingPaths.size !== existing.length || new Set(additions.map((member) => member.worktreePath)).size !== additions.length || additions.some((member) => existingPaths.has(member.worktreePath))) throw new Error('Duplicate worktree members cannot be persisted.')
  const byPath = new Map(existing.map((member) => [member.worktreePath, member]))
  for (const member of additions) byPath.set(member.worktreePath, member)
  if (orderedPaths.some((path) => !byPath.has(path))) throw new Error('Selected worktree member is unavailable.')
  const members = orderedPaths.map((path) => byPath.get(path)!)
  return {
    members,
    removed: existing.filter((member) => !selected.has(member.worktreePath)).length,
    reordered: members.filter((member, index) => existing[index]?.worktreePath !== member.worktreePath).length,
  }
}
