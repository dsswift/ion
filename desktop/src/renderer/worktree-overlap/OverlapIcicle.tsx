import React, { useMemo } from 'react'
import type { WorktreeOverlapAnalysis, WorktreeOverlapPair } from '../../shared/types-worktree-overlap'
import { useColors } from '../theme'

export function OverlapIcicle({ analysis, pair, onSelectPath }: {
  analysis: WorktreeOverlapAnalysis
  pair?: WorktreeOverlapPair
  onSelectPath(path: string): void
}): React.JSX.Element {
  const colors = useColors()
  const paths = useMemo(() => {
    const selected = pair?.sharedFiles.map((file) => file.path) ?? []
    return selected.length > 0 ? selected : analysis.footprints.flatMap((item) => item.files.map((file) => file.path))
  }, [analysis, pair])
  const weights = new Map<string, number>()
  for (const footprint of analysis.footprints) for (const file of footprint.files) {
    if (paths.includes(file.path)) weights.set(file.path, (weights.get(file.path) ?? 0) + changedWeight(file))
  }
  const total = [...weights.values()].reduce((sum, value) => sum + value, 0) || 1
  const display = [...weights].sort(([, left], [, right]) => right - left).slice(0, 18)
  const hiddenCount = weights.size - display.length
  return <div style={{ display: 'flex', minHeight: 54, overflow: 'hidden', borderRadius: 7, border: `1px solid ${colors.containerBorder}` }}>
    {display.map(([path, weight]) => <button key={path} onClick={() => onSelectPath(path)} style={{ flex: weight, minWidth: 28, border: 'none', borderRight: `1px solid ${colors.containerBorder}`, background: pair?.conflictPaths.includes(path) ? colors.dangerFg : colors.accentLight, color: colors.textPrimary, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', padding: 4, fontSize: 9 }} aria-label={`${path}, ${Math.round(weight / total * 100)} percent of changed lines`}>{path.split('/').pop()}</button>)}
    {hiddenCount > 0 && <span style={{ padding: 8, color: colors.textTertiary, fontSize: 10 }}>+{hiddenCount} more</span>}
    {weights.size === 0 && <span style={{ padding: 10, color: colors.textTertiary, fontSize: 11 }}>No changed paths match this selection.</span>}
  </div>
}

function changedWeight(file: WorktreeOverlapAnalysis['footprints'][number]['files'][number]): number {
  if (file.additions === null || file.deletions === null) return 1
  return Math.max(1, file.additions + file.deletions)
}
