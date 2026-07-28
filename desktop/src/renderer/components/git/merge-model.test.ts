/**
 * merge-model — the diff3 alignment the MergeEditor trusts.
 *
 * The property that matters: a non-overlapping change from either side applies
 * automatically (exactly as `git merge` would), and only genuinely contested
 * regions demand a decision. Getting this wrong in either direction is a
 * defect — auto-applying a contested chunk silently loses someone's change,
 * and flagging a clean chunk as conflicted buries the operator in noise.
 */
import { describe, it, expect } from 'vitest'
import { buildMergeModel, applyChunk, unresolvedCount, composeResult } from './merge-model'

const BASE = 'line1\nline2\nline3\nline4\nline5\n'

describe('buildMergeModel — one-sided changes auto-apply', () => {
  it('applies an ours-only change with no conflict', () => {
    const ours = 'line1\nOURS\nline3\nline4\nline5\n'
    const model = buildMergeModel(BASE, ours, BASE)
    expect(unresolvedCount(model)).toBe(0)
    expect(composeResult(model)).toBe(ours)
  })

  it('applies a theirs-only change with no conflict', () => {
    const theirs = 'line1\nline2\nline3\nTHEIRS\nline5\n'
    const model = buildMergeModel(BASE, BASE, theirs)
    expect(unresolvedCount(model)).toBe(0)
    expect(composeResult(model)).toBe(theirs)
  })

  it('merges non-overlapping changes from both sides', () => {
    // Ours edits line2, theirs edits line4 — separated by untouched line3.
    const ours = 'line1\nOURS\nline3\nline4\nline5\n'
    const theirs = 'line1\nline2\nline3\nTHEIRS\nline5\n'
    const model = buildMergeModel(BASE, ours, theirs)
    expect(unresolvedCount(model)).toBe(0)
    expect(composeResult(model)).toBe('line1\nOURS\nline3\nTHEIRS\nline5\n')
  })

  it('treats an identical change on both sides as agreement, not conflict', () => {
    const both = 'line1\nSAME\nline3\nline4\nline5\n'
    const model = buildMergeModel(BASE, both, both)
    expect(unresolvedCount(model)).toBe(0)
    expect(composeResult(model)).toBe(both)
  })

  it('handles insertions on one side', () => {
    const ours = 'line1\nline2\nINSERTED\nline3\nline4\nline5\n'
    const model = buildMergeModel(BASE, ours, BASE)
    expect(unresolvedCount(model)).toBe(0)
    expect(composeResult(model)).toBe(ours)
  })

  it('returns the base unchanged when neither side changed anything', () => {
    const model = buildMergeModel(BASE, BASE, BASE)
    expect(unresolvedCount(model)).toBe(0)
    expect(composeResult(model)).toBe(BASE)
  })
})

describe('buildMergeModel — contested regions are conflicts', () => {
  it('flags both sides editing the same line', () => {
    // The live incident's shape: shared.txt line2 edited differently.
    const ours = 'line1\nOURS\nline3\nline4\nline5\n'
    const theirs = 'line1\nTHEIRS\nline3\nline4\nline5\n'
    const model = buildMergeModel(BASE, ours, theirs)

    expect(unresolvedCount(model)).toBe(1)
    expect(composeResult(model)).toBeNull()

    const conflict = model.chunks.find((c) => c.kind === 'conflict')!
    expect(conflict.ours).toEqual(['OURS'])
    expect(conflict.theirs).toEqual(['THEIRS'])
    expect(conflict.base).toEqual(['line2'])
  })

  it('resolves a conflict to ours, theirs, both, or skip', () => {
    const ours = 'line1\nOURS\nline3\nline4\nline5\n'
    const theirs = 'line1\nTHEIRS\nline3\nline4\nline5\n'
    const model = buildMergeModel(BASE, ours, theirs)
    const idx = model.chunks.findIndex((c) => c.kind === 'conflict')

    expect(composeResult(applyChunk(model, idx, 'ours'))).toBe(ours)
    expect(composeResult(applyChunk(model, idx, 'theirs'))).toBe(theirs)
    expect(composeResult(applyChunk(model, idx, 'both')))
      .toBe('line1\nOURS\nTHEIRS\nline3\nline4\nline5\n')
    expect(composeResult(applyChunk(model, idx, 'skip'))).toBe(BASE)
  })

  it('keeps auto-applied chunks while a separate conflict is pending', () => {
    // Theirs also cleanly edits line5; that must survive the line2 conflict.
    const ours = 'line1\nOURS\nline3\nline4\nline5\n'
    const theirs = 'line1\nTHEIRS\nline3\nline4\nFIVE\n'
    let model = buildMergeModel(BASE, ours, theirs)
    expect(unresolvedCount(model)).toBe(1)

    model = applyChunk(model, model.chunks.findIndex((c) => c.kind === 'conflict'), 'ours')
    expect(composeResult(model)).toBe('line1\nOURS\nline3\nline4\nFIVE\n')
  })

  it('flags overlapping multi-line rewrites as one conflict chunk', () => {
    const ours = 'line1\nA1\nA2\nline4\nline5\n'      // rewrote lines 2-3
    const theirs = 'line1\nline2\nB1\nB2\nline5\n'    // rewrote lines 3-4
    const model = buildMergeModel(BASE, ours, theirs)
    expect(unresolvedCount(model)).toBe(1)
    const conflict = model.chunks.find((c) => c.kind === 'conflict')!
    // The contested span covers the union of both rewrites (base lines 2-4).
    expect(conflict.base).toEqual(['line2', 'line3', 'line4'])
  })
})

describe('buildMergeModel — degraded shapes', () => {
  it('add/add (no base) is one whole-file conflict', () => {
    const model = buildMergeModel(null, 'ours content\n', 'theirs content\n')
    expect(model.degradedNoBase).toBe(true)
    expect(unresolvedCount(model)).toBe(1)
    expect(composeResult(applyChunk(model, 0, 'ours'))).toBe('ours content\n')
    expect(composeResult(applyChunk(model, 0, 'theirs'))).toBe('theirs content\n')
  })

  it('delete/modify: the deleting side offers an empty result', () => {
    // Theirs deleted the file; ours modified line2. Contested everywhere ours
    // changed; accepting theirs on the whole-file conflict composes empty.
    const ours = 'line1\nOURS\nline3\nline4\nline5\n'
    const model = buildMergeModel(BASE, ours, null)
    expect(unresolvedCount(model)).toBeGreaterThan(0)
    let resolved = model
    model.chunks.forEach((c, i) => {
      if (c.kind === 'conflict' && c.resolution === null) resolved = applyChunk(resolved, i, 'theirs')
    })
    expect(composeResult(resolved)).toBe('')
  })

  it('handles a file with no trailing newline', () => {
    const model = buildMergeModel('a\nb', 'a\nB', 'a\nb')
    expect(composeResult(model)).toBe('a\nB\n')
  })
})
