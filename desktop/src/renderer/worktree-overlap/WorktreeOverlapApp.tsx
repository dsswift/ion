import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { WorktreeOverlapAnalysis, WorktreeOverlapApplyPreview, WorktreeOverlapBasis, WorktreeOverlapPair, WorktreeOverlapSolverResult } from '../../shared/types-worktree-overlap'
import { useColors } from '../theme'
import { rError } from '../rendererLogger'
import { OverlapRing } from './OverlapRing'
import { OverlapIcicle } from './OverlapIcicle'
import { OverlapInspector } from './OverlapInspector'
import { OverlapSolverPanel } from './OverlapSolverPanel'
import { ConfirmDialog } from '../components/git/ConfirmDialog'
import { filterOverlapAnalysis } from './filter-analysis'

export function WorktreeOverlapApp(): React.JSX.Element {
  const colors = useColors()
  const request = useRef(0)
  const [basis, setBasis] = useState<WorktreeOverlapBasis>('live')
  const [analysis, setAnalysis] = useState<WorktreeOverlapAnalysis | null>(null)
  const [solver, setSolver] = useState<WorktreeOverlapSolverResult | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [keptPaths, setKeptPaths] = useState<string[]>([])
  const [selectedPair, setSelectedPair] = useState<WorktreeOverlapPair | undefined>()
  const [pathFilter, setPathFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [applyPreview, setApplyPreview] = useState<WorktreeOverlapApplyPreview | null>(null)
  const [applying, setApplying] = useState(false)
  const [loading, setLoading] = useState(true)
  const load = useCallback((nextBasis: WorktreeOverlapBasis, keep: string[] = []) => {
    const id = ++request.current
    setLoading(true); setError(null)
    void window.ion.getWorktreeOverlap(nextBasis).then(async (result) => {
      if (id !== request.current) return
      if (!result.analysis) { setError(result.error ?? 'Overlap analysis returned no data.'); return }
      const solved = await window.ion.solveWorktreeOverlap(nextBasis, keep)
      if (id !== request.current) return
      if (!solved.solver) { setError(solved.error ?? 'Could not solve selected worktrees.'); return }
      setAnalysis(result.analysis); setSolver(solved.solver); setKeptPaths(keep); setSelectedPaths(solved.solver.constrained.orderedPaths); setSelectedPair(undefined)
    }).catch((reason) => { if (id === request.current) { rError('worktree.overlap', 'analysis request failed', { error: String(reason) }); setError(String(reason)) } }).finally(() => { if (id === request.current) setLoading(false) })
  }, [])
  useEffect(() => { load(basis) }, [basis, load])
  const toggleSelected = (path: string): void => setSelectedPaths((paths) => paths.includes(path) ? paths.filter((item) => item !== path) : [...paths, path])
  const toggleKeep = (path: string): void => load(basis, keptPaths.includes(path) ? keptPaths.filter((item) => item !== path) : [...keptPaths, path])
  const autoOrder = (): void => {
    void window.ion.autoOrderWorktreeOverlap(basis, selectedPaths).then((result) => {
      if (result.cohort) setSelectedPaths(result.cohort.orderedPaths)
      else setError(result.error ?? 'Could not auto-order current selection.')
    }).catch((reason) => { rError('worktree.overlap', 'auto-order failed', { error: String(reason) }); setError(String(reason)) })
  }
  const requestApply = (): void => { void window.ion.previewWorktreeOverlapApply(basis, selectedPaths).then((result) => { if (result.preview) setApplyPreview(result.preview); else setError(result.error ?? 'Could not preview selection changes.') }).catch((reason) => { rError('worktree.overlap', 'apply preview failed', { error: String(reason) }); setError(String(reason)) }) }
  const confirmApply = (): void => { if (!applyPreview) return; setApplying(true); void window.ion.applyWorktreeOverlap(basis, applyPreview.orderedPaths).then((result) => { if (!result.ok) setError(result.error ?? 'Selection was not applied.'); setApplyPreview(null); if (result.ok) load(basis, keptPaths) }).catch((reason) => { rError('worktree.overlap', 'apply selection failed', { error: String(reason) }); setError(String(reason)); setApplyPreview(null) }).finally(() => setApplying(false)) }
  const visible = filterOverlapAnalysis(analysis, pathFilter)
  return <main style={{ height: '100vh', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 8, padding: 10, background: colors.containerBg, color: colors.textPrimary }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div style={{ flex: 1 }}><strong>Worktree overlap</strong>{analysis && <span style={{ marginLeft: 8, fontSize: 11, color: colors.textTertiary }}>{analysis.sourceBranch || 'all source branches'} · {analysis.footprints.length} worktrees</span>}</div><label style={{ fontSize: 11, color: colors.textSecondary }}>basis <select value={basis} onChange={(event) => setBasis(event.target.value as WorktreeOverlapBasis)} style={{ marginLeft: 4 }}><option value="live">live tips</option><option value="pins">current bench pins</option></select></label><input value={pathFilter} onChange={(event) => setPathFilter(event.target.value)} placeholder="filter path" aria-label="Filter paths" style={{ padding: 4 }} /></header>
    {loading && <div style={{ color: colors.textTertiary }}>Reading Git contribution ranges…</div>}{error && <div style={{ color: colors.dangerFg }}>Overlap analysis failed: {error}</div>}
    {visible && solver && <><section style={{ minHeight: 0, flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(240px, 300px)', gap: 8 }}><div style={{ minHeight: 0, overflow: 'auto', padding: 8, border: `1px solid ${colors.containerBorder}`, borderRadius: 8 }}><OverlapRing analysis={visible} selectedPaths={selectedPaths} keptPaths={keptPaths} onToggle={toggleSelected} onToggleKeep={toggleKeep} onSelectPair={setSelectedPair} /></div><aside style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}><OverlapSolverPanel solver={solver} onAdopt={setSelectedPaths} onAutoOrder={autoOrder} onApply={requestApply} />{selectedPair && <div style={{ padding: 8, border: `1px solid ${colors.containerBorder}`, borderRadius: 8 }}><OverlapInspector pair={selectedPair} /></div>}</aside></section><section><div style={{ fontSize: 11, color: colors.textTertiary, marginBottom: 4 }}>Changed-path partition</div><OverlapIcicle analysis={visible} pair={selectedPair} onSelectPath={setPathFilter} /></section></>}
    {applyPreview && <ConfirmDialog title="Apply selected worktrees?" message={applyMessage(applyPreview, analysis)} confirmLabel="Apply selection" busy={applying} busyLabel="Applying bench membership and order…" onCancel={() => { if (!applying) setApplyPreview(null) }} onConfirm={confirmApply} />}
  </main>
}
function applyMessage(preview: WorktreeOverlapApplyPreview, analysis: WorktreeOverlapAnalysis | null): string { const names = new Map(analysis?.footprints.map((item) => [item.worktreePath, item.title ?? item.branchName]) ?? []); const list = (paths: string[]): string => paths.map((path) => names.get(path) ?? path).join(', ') || 'none'; return [preview.prediction === 'clean' ? 'Exact current simulation merges cleanly.' : `Exact simulation reports ${preview.prediction}: ${preview.error ?? 'review conflicts before confirming.'}`, `Add to bench: ${list(preview.newlyEnrolled)}.`, `Remove from bench: ${list(preview.removed)}.`, `Merge order: ${list(preview.orderedPaths)}.`].join('\n') }
