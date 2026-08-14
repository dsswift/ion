/** Pure member-set transform for an already-validated overlap recommendation. */
import type { IntegrationMember } from '../../shared/types'

export function applyRecommendationMembers(
  existing: IntegrationMember[],
  orderedPaths: string[],
  additions: IntegrationMember[],
): { members: IntegrationMember[]; enabled: number; disabled: number; reordered: number } {
  const selected = new Set(orderedPaths)
  if (selected.size !== orderedPaths.length) throw new Error('Duplicate worktree paths cannot be applied.')
  const existingPaths = new Set(existing.map((member) => member.worktreePath))
  if (existingPaths.size !== existing.length || new Set(additions.map((member) => member.worktreePath)).size !== additions.length || additions.some((member) => existingPaths.has(member.worktreePath))) throw new Error('Duplicate worktree members cannot be persisted.')
  const byPath = new Map(existing.map((member) => [member.worktreePath, member]))
  for (const member of additions) byPath.set(member.worktreePath, member)
  if (orderedPaths.some((path) => !byPath.has(path))) throw new Error('Selected worktree member is unavailable.')
  const remainder = existing.map((member) => member.worktreePath).filter((path) => !selected.has(path))
  const finalOrder = [...orderedPaths, ...remainder]
  const members = finalOrder.map((path) => ({ ...byPath.get(path)!, enabled: selected.has(path) }))
  return {
    members,
    enabled: members.filter((member) => member.enabled && !existing.find((old) => old.worktreePath === member.worktreePath)?.enabled).length,
    disabled: existing.filter((member) => member.enabled && !selected.has(member.worktreePath)).length,
    reordered: finalOrder.filter((path, index) => existing[index]?.worktreePath !== path).length,
  }
}
