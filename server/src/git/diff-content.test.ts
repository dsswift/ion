import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadCommitFileDiff, loadGitDiff } from './diff-content'

const dirs: string[] = []

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ion-diff-content-'))
  dirs.push(dir)
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Developer'], { cwd: dir })
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('diff content', () => {
  it('keeps untracked text diffable through Git', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'note.txt'), 'hello\n')

    await expect(loadGitDiff(dir, 'note.txt', false)).resolves.toMatchObject({
      isBinary: false,
      fileName: 'note.txt',
    })
    const result = await loadGitDiff(dir, 'note.txt', false)
    expect(result.diff).toContain('+hello')
  })

  it('strips untracked binary data before it reaches a viewer', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'asset.bin'), Buffer.from([0, 1, 2, 3, 4]))

    await expect(loadGitDiff(dir, 'asset.bin', false)).resolves.toEqual({
      diff: '',
      fileName: 'asset.bin',
      isBinary: true,
    })
  })

  it('strips staged binary data before it reaches a viewer', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'asset.bin'), Buffer.from([0, 1, 2, 3, 4]))
    execFileSync('git', ['add', '-f', 'asset.bin'], { cwd: dir })

    await expect(loadGitDiff(dir, 'asset.bin', true)).resolves.toEqual({
      diff: '',
      fileName: 'asset.bin',
      isBinary: true,
    })
  })

  it('strips binary commit patches while retaining file metadata', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'asset.bin'), Buffer.from([0, 1, 2, 3, 4]))
    execFileSync('git', ['add', '-f', 'asset.bin'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'add asset'], { cwd: dir, stdio: 'ignore' })
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()

    await expect(loadCommitFileDiff(dir, hash, 'asset.bin')).resolves.toEqual({
      diff: '',
      fileName: 'asset.bin',
      isBinary: true,
    })
  })
})
