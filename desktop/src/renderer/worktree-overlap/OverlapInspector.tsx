import React from 'react'
import type { WorktreeOverlapPair } from '../../shared/types-worktree-overlap'
import { useColors } from '../theme'

export function OverlapInspector({ pair }: { pair?: WorktreeOverlapPair }): React.JSX.Element {
  const colors = useColors()
  if (!pair) return <div style={{ color: colors.textTertiary, fontSize: 12, padding: 12 }}>Select a matrix cell to inspect exact overlap evidence.</div>
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, fontSize: 12, overflowWrap: 'anywhere' }}>
    <strong style={{ color: colors.textPrimary }}>Pair evidence</strong>
    <div style={{ color: pair.prediction === 'conflict' ? colors.dangerFg : colors.textSecondary }}>
      Merge prediction: {pair.prediction}
    </div>
    {pair.error && <div style={{ color: colors.warningFg }}>Git could not complete prediction: {pair.error}</div>}
    {pair.conflictPaths.length > 0 && <Section label="Exact conflict paths" values={pair.conflictPaths} colors={colors} />}
    <Section label="Shared files" values={pair.sharedFiles.map((file) => `${file.path}${file.sameHunk ? ' · same base hunk' : ''}`)} colors={colors} />
    <Section label="Shared directories" values={pair.sharedDirectories} colors={colors} />
    {pair.advisoryFiles.length > 0 && <Section label="Uncommitted advisory overlap" values={pair.advisoryFiles} colors={colors} />}
  </div>
}

function Section({ label, values, colors }: { label: string; values: string[]; colors: ReturnType<typeof useColors> }): React.JSX.Element | null {
  if (values.length === 0) return null
  return <div style={{ minWidth: 0 }}><div style={{ color: colors.textTertiary, fontSize: 10, marginBottom: 3 }}>{label}</div>{values.map((value) => <div key={value} style={{ color: colors.textSecondary, fontFamily: 'monospace', fontSize: 11, overflowWrap: 'anywhere' }}>{value}</div>)}</div>
}
