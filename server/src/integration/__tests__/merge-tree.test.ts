import { describe, expect, it } from 'vitest'
import { mergeTree } from '../merge-tree'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function git(dir: string, args: string[]): string { return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }) }

describe('mergeTree', () => {
  it('returns machine-readable conflicted paths with spaces', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ion-merge-tree-'))
    try {
      git(repo, ['init', '-q']); git(repo, ['config', 'user.email', 'dev@example.com']); git(repo, ['config', 'user.name', 'Dev'])
      writeFileSync(join(repo, 'shared file.txt'), 'base\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base'])
      git(repo, ['branch', 'left']); git(repo, ['branch', 'right'])
      git(repo, ['checkout', '-q', 'left']); writeFileSync(join(repo, 'shared file.txt'), 'left\n'); git(repo, ['commit', '-am', 'left', '-q'])
      git(repo, ['checkout', '-q', 'right']); writeFileSync(join(repo, 'shared file.txt'), 'right\n'); git(repo, ['commit', '-am', 'right', '-q'])
      await expect(mergeTree(repo, 'left', 'right')).resolves.toMatchObject({ prediction: 'conflict', conflictPaths: ['shared file.txt'] })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('keeps clean rename merges clean when Git appends informational records', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ion-merge-tree-rename-'))
    try {
      git(repo, ['init', '-q']); git(repo, ['config', 'user.email', 'dev@example.com']); git(repo, ['config', 'user.name', 'Dev'])
      writeFileSync(join(repo, 'before.txt'), 'base\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base'])
      git(repo, ['branch', 'left']); git(repo, ['branch', 'right'])
      git(repo, ['checkout', '-q', 'left']); git(repo, ['mv', 'before.txt', 'after.txt']); git(repo, ['commit', '-qm', 'rename'])
      git(repo, ['checkout', '-q', 'right']); writeFileSync(join(repo, 'right.txt'), 'right\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'right'])
      await expect(mergeTree(repo, 'left', 'right')).resolves.toMatchObject({ prediction: 'clean', tree: expect.any(String) })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})
