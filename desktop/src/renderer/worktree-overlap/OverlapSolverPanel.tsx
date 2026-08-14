import React from 'react'
import { CheckCircle, PushPin, Sparkle, WarningCircle } from '@phosphor-icons/react'
import type { WorktreeOverlapCohort, WorktreeOverlapSolverResult } from '../../shared/types-worktree-overlap'
import { useColors } from '../theme'

export function OverlapSolverPanel({ solver, onAdopt, onAutoOrder, onApply }: { solver: WorktreeOverlapSolverResult; onAdopt(paths: string[]): void; onAutoOrder(): void; onApply(): void }): React.JSX.Element {
  const colors = useColors()
  return <section style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div style={{ fontSize: 12, color: colors.textPrimary }}><Sparkle size={13} /> Solver</div>
    <Cohort title="Best with what you keep" cohort={solver.constrained} icon={<PushPin size={12} />} color={solver.constrained.prediction === 'clean' ? colors.accent : colors.dangerFg} onAdopt={onAdopt} />
    <Cohort title="Hypothetical best" cohort={solver.hypothetical} icon={<CheckCircle size={12} />} color={colors.accent} onAdopt={onAdopt} />
    <div style={{ borderTop: `1px solid ${colors.containerBorder}`, paddingTop: 7 }}>
      <button data-testid="overlap-auto-order" onClick={onAutoOrder} style={{ fontSize: 10 }}>Auto-order current selection</button>
      <span style={{ display: 'block', marginTop: 3, fontSize: 10, color: colors.textTertiary }}>Changes order only. Worktree selection stays yours.</span>
    </div>
    <button data-testid="overlap-apply-selection" onClick={onApply} style={{ fontSize: 10 }}>Apply selection…</button>
  </section>
}

function Cohort({ title, cohort, icon, color, onAdopt }: { title: string; cohort: WorktreeOverlapCohort; icon: React.ReactNode; color: string; onAdopt(paths: string[]): void }): React.JSX.Element {
  return <div style={{ padding: 6, borderRadius: 6, background: 'rgba(0,0,0,0.06)' }}>
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', color, fontSize: 11 }}><span>{icon}</span><strong>{title}</strong></div>
    <div style={{ marginTop: 3, fontSize: 10, color }}>{cohort.prediction === 'clean' ? `${cohort.orderedPaths.length} worktrees merge cleanly` : `${cohort.firstFailingBranch ?? 'selection'} conflicts${cohort.conflictPaths.length ? `: ${cohort.conflictPaths.join(', ')}` : ''}`}</div>
    {cohort.note && <div style={{ marginTop: 3, fontSize: 10, color }}><WarningCircle size={11} /> {cohort.note}</div>}
    <button onClick={() => onAdopt(cohort.orderedPaths)} style={{ marginTop: 5, fontSize: 10 }}>Use this selection</button>
  </div>
}
