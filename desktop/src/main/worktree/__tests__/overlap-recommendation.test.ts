import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { recommendWorktreeCohort, reorderCurrentSelection, solveWorktreeOverlap } from '../overlap-recommendation'
import type { WorktreeOverlapAnalysis } from '../../../shared/types-worktree-overlap'

function git(dir: string, args: string[]): string { return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }) }

function footprint(path: string): WorktreeOverlapAnalysis['footprints'][number] {
  return { worktreePath: path, branchName: path, sourceBranch: 'main', baseSha: 'base', tipSha: path, files: [], enrolled: false, landed: false }
}

describe('recommendWorktreeCohort', () => {
  it('maximizes clean cohort and names the concrete conflicting exclusion', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ion-overlap-recommend-'))
    try {
      git(repo, ['init', '-q']); git(repo, ['config', 'user.email', 'dev@example.com']); git(repo, ['config', 'user.name', 'Dev'])
      writeFileSync(join(repo, 'shared.ts'), 'base\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base']); git(repo, ['branch', '-M', 'main'])
      git(repo, ['branch', 'a']); git(repo, ['branch', 'b']); git(repo, ['branch', 'c'])
      git(repo, ['checkout', '-q', 'a']); writeFileSync(join(repo, 'a.ts'), 'a\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'a'])
      git(repo, ['checkout', '-q', 'b']); writeFileSync(join(repo, 'shared.ts'), 'b\n'); git(repo, ['commit', '-am', 'b', '-q'])
      git(repo, ['checkout', '-q', 'c']); writeFileSync(join(repo, 'shared.ts'), 'c\n'); git(repo, ['commit', '-am', 'c', '-q'])
      const analysis: WorktreeOverlapAnalysis = {
        repoPath: repo, sourceBranch: 'main', basis: 'live', computedAt: 0, footprints: [footprint('a'), footprint('b'), footprint('c')], incompletePaths: [],
        pairs: [
          { leftPath: 'a', rightPath: 'b', sharedDirectories: [], sharedFiles: [], advisoryFiles: [], ancestry: 'diverged', prediction: 'clean', conflictPaths: [] },
          { leftPath: 'a', rightPath: 'c', sharedDirectories: [], sharedFiles: [], advisoryFiles: [], ancestry: 'diverged', prediction: 'clean', conflictPaths: [] },
          { leftPath: 'b', rightPath: 'c', sharedDirectories: [], sharedFiles: [], advisoryFiles: [], ancestry: 'diverged', prediction: 'conflict', conflictPaths: ['shared.ts'] },
        ], recommendation: { kind: 'exact', orderedPaths: [], alternatives: [], blockers: [], pairScope: [] },
      }
      const result = await recommendWorktreeCohort(analysis)
      expect(result.orderedPaths).toHaveLength(2)
      expect(result.orderedPaths).not.toEqual(expect.arrayContaining(['b', 'c']))
      expect(result.blockers).toHaveLength(1)
      expect(result.blockers[0]).toMatchObject({ reason: 'conflict', conflictPaths: ['shared.ts'] })
      const constrained = await solveWorktreeOverlap(analysis, ['b', 'c'])
      expect(constrained.constrained.orderedPaths).toEqual(['b', 'c'])
      expect(constrained.constrained).toMatchObject({ prediction: 'conflict', conflictPaths: ['shared.ts'] })
      expect(constrained.hypothetical.prediction).toBe('clean')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})
describe('reorderCurrentSelection bounds', () => {
  it('retains existing order over candidate cap instead of factorial search', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ion-overlap-bound-'))
    try {
      git(repo, ['init', '-q']); git(repo, ['config', 'user.email', 'dev@example.com']); git(repo, ['config', 'user.name', 'Dev'])
      writeFileSync(join(repo, 'base.ts'), 'base\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base']); git(repo, ['branch', '-M', 'main'])
      const paths: string[] = []
      for (let index = 0; index < 13; index++) { const branch = `branch-${index}`; git(repo, ['branch', branch]); git(repo, ['checkout', '-q', branch]); writeFileSync(join(repo, `${branch}.ts`), `${branch}\n`); git(repo, ['add', '.']); git(repo, ['commit', '-qm', branch]); paths.push(branch) }
      const analysis: WorktreeOverlapAnalysis = { repoPath: repo, sourceBranch: 'main', basis: 'live', computedAt: 0, footprints: paths.map(footprint), incompletePaths: [], pairs: [], recommendation: { kind: 'exact', orderedPaths: [], alternatives: [], blockers: [], pairScope: [] } }
      const reordered = await reorderCurrentSelection(
        analysis,
        git(repo, ['rev-parse', 'main']).trim(),
        paths,
        'anchored',
      )
      expect(reordered.orderedPaths).toEqual(paths)
      expect(reordered.kind).toBe('anchored')
      expect(reordered.note).toContain('at most 12')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  }, 30_000)
})
