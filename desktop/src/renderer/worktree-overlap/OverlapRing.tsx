import React, { useMemo } from 'react'
import { CheckCircle, PushPin, WarningCircle, XCircle } from '@phosphor-icons/react'
import type { WorktreeOverlapAnalysis, WorktreeOverlapPair } from '../../shared/types-worktree-overlap'
import { useColors } from '../theme'

export function OverlapRing({ analysis, selectedPaths, keptPaths, onToggle, onToggleKeep, onSelectPair }: {
  analysis: WorktreeOverlapAnalysis
  selectedPaths: string[]
  keptPaths: string[]
  onToggle(path: string): void
  onToggleKeep(path: string): void
  onSelectPair(pair: WorktreeOverlapPair): void
}): React.JSX.Element {
  const colors = useColors()
  const size = 520
  const center = size / 2
  const selected = selectedPaths.map((path) => analysis.footprints.find((item) => item.worktreePath === path)).filter((item): item is NonNullable<typeof item> => !!item)
  const excluded = analysis.footprints.filter((item) => !selectedPaths.includes(item.worktreePath))
  const selectedPos = positions(selected.map((item) => item.worktreePath), 140, center)
  const excludedPos = positions(excluded.map((item) => item.worktreePath), 225, center)
  const tethers = useMemo(() => analysis.pairs.filter((pair) => pair.prediction === 'conflict' && ((selectedPaths.includes(pair.leftPath) && !selectedPaths.includes(pair.rightPath)) || (selectedPaths.includes(pair.rightPath) && !selectedPaths.includes(pair.leftPath)))), [analysis.pairs, selectedPaths])
  return <section style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><strong style={{ fontSize: 12 }}>Bench ring</strong><span style={{ fontSize: 10, color: colors.textTertiary }}>Inside = selected. Outside = held out. Pin = keep.</span></div>
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Bench ring showing selected worktrees and excluded conflict blockers" style={{ width: '100%', maxHeight: 520, background: colors.surfacePrimary, borderRadius: 10, border: `1px solid ${colors.containerBorder}` }}>
      <circle cx={center} cy={center} r={170} fill="none" stroke={colors.containerBorder} strokeWidth="2" />
      <text x={center} y={center - 4} textAnchor="middle" fill={colors.textSecondary} fontSize="14">Integration bench</text>
      <text x={center} y={center + 16} textAnchor="middle" fill={colors.textTertiary} fontSize="10">{selected.length} selected</text>
      {tethers.map((pair) => {
        const insidePath = selectedPaths.includes(pair.leftPath) ? pair.leftPath : pair.rightPath
        const outsidePath = insidePath === pair.leftPath ? pair.rightPath : pair.leftPath
        const from = selectedPos.get(insidePath); const to = excludedPos.get(outsidePath)
        if (!from || !to) return null
        return <g key={`${pair.leftPath}:${pair.rightPath}`} onClick={() => onSelectPair(pair)} style={{ cursor: 'pointer' }}>
          <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={colors.dangerFg} strokeWidth="2" strokeDasharray="4 3" />
          <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2} fill={colors.dangerFg} fontSize="10">{pair.conflictPaths.length || '!'}</text>
        </g>
      })}
      {selected.map((item) => <Chip key={item.worktreePath} item={item} point={selectedPos.get(item.worktreePath)!} selected kept={keptPaths.includes(item.worktreePath)} sameHunk={hasSameHunk(analysis, item.worktreePath, selectedPaths)} colors={colors} onToggle={onToggle} onToggleKeep={onToggleKeep} />)}
      {excluded.map((item) => <Chip key={item.worktreePath} item={item} point={excludedPos.get(item.worktreePath)!} selected={false} kept={keptPaths.includes(item.worktreePath)} sameHunk={false} colors={colors} onToggle={onToggle} onToggleKeep={onToggleKeep} />)}
    </svg>
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10, color: colors.textSecondary }}><span><CheckCircle size={11} /> selected</span><span><WarningCircle size={11} /> same hunk</span><span><XCircle size={11} /> exact blocker tether</span><span><PushPin size={11} /> keep constraint</span></div>
  </section>
}

function Chip({ item, point, selected, kept, sameHunk, colors, onToggle, onToggleKeep }: { item: WorktreeOverlapAnalysis['footprints'][number]; point: { x: number; y: number }; selected: boolean; kept: boolean; sameHunk: boolean; colors: ReturnType<typeof useColors>; onToggle(path: string): void; onToggleKeep(path: string): void }): React.JSX.Element {
  const radius = Math.min(34, Math.max(18, Math.sqrt(item.files.reduce((sum, file) => sum + Math.max(1, (file.additions ?? 1) + (file.deletions ?? 1)), 0)) * 2))
  const label = item.title ?? item.branchName
  return <g transform={`translate(${point.x} ${point.y})`}>
    {sameHunk && <circle r={radius + 5} fill="none" stroke={colors.warningFg} strokeWidth="3" />}
    <circle r={radius} fill={selected ? colors.accentLight : colors.surfaceHover} stroke={selected ? colors.accent : colors.containerBorder} strokeWidth="2" onClick={() => onToggle(item.worktreePath)} style={{ cursor: 'pointer' }} />
    <text textAnchor="middle" y="3" fill={colors.textPrimary} fontSize="9" pointerEvents="none">{label.slice(0, 12)}</text>
    <text x={radius - 4} y={-radius + 8} fill={kept ? colors.warningFg : colors.textTertiary} fontSize="12" onClick={() => onToggleKeep(item.worktreePath)} style={{ cursor: 'pointer' }}>{kept ? '★' : '☆'}</text>
  </g>
}
function positions(paths: string[], radius: number, center: number): Map<string, { x: number; y: number }> { return new Map(paths.map((path, index) => { const angle = -Math.PI / 2 + index * (Math.PI * 2 / Math.max(1, paths.length)); return [path, { x: center + Math.cos(angle) * radius, y: center + Math.sin(angle) * radius }] })) }
function hasSameHunk(analysis: WorktreeOverlapAnalysis, path: string, selected: string[]): boolean { return analysis.pairs.some((pair) => pair.sharedFiles.some((file) => file.sameHunk) && ((pair.leftPath === path && selected.includes(pair.rightPath)) || (pair.rightPath === path && selected.includes(pair.leftPath)))) }
