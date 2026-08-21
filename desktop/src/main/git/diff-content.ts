import { basename } from 'path'
import { runGit, runGitAllowingDiffExit } from '../git-runner'
import { debug, log } from '../logger'
import type { GitDiffResult } from '../../shared/types-git'

const BINARY_DIFF_RE = /(?:^Binary files .* differ$|^GIT binary patch$)/m

function normalizeDiff(diff: string, filePath: string): GitDiffResult {
  const isBinary = BINARY_DIFF_RE.test(diff)
  return { diff: isBinary ? '' : diff, fileName: basename(filePath), isBinary }
}

/**
 * Loads a working-tree diff without ever decoding an untracked file as UTF-8.
 * Git owns binary classification for tracked, staged, and untracked content.
 */
export async function loadGitDiff(directory: string, filePath: string, staged: boolean): Promise<GitDiffResult> {
  log('git-diff', 'load started', { directory, path: filePath, staged })
  try {
    let diff = staged
      ? await runGit(directory, ['diff', '--cached', '--', filePath])
      : await runGit(directory, ['diff', '--', filePath])

    if (!staged && !diff.trim()) {
      diff = await runGitAllowingDiffExit(directory, ['diff', '--no-index', '--', '/dev/null', filePath])
    }

    const result = normalizeDiff(diff, filePath)
    log('git-diff', 'load completed', { directory, path: filePath, staged, is_binary: result.isBinary, diff_bytes: result.diff.length })
    return result
  } catch (err) {
    debug('git-diff', 'load failed', { directory, path: filePath, staged, error: String(err) })
    throw err
  }
}

/** Load one file's patch from a commit with the same binary-content boundary. */
export async function loadCommitFileDiff(directory: string, hash: string, filePath: string): Promise<GitDiffResult> {
  log('git-diff', 'commit diff load started', { directory, hash, path: filePath })
  try {
    const result = normalizeDiff(await runGit(directory, ['diff-tree', '-p', '--root', hash, '--', filePath]), filePath)
    log('git-diff', 'commit diff load completed', { directory, hash, path: filePath, is_binary: result.isBinary, diff_bytes: result.diff.length })
    return result
  } catch (err) {
    debug('git-diff', 'commit diff load failed', { directory, hash, path: filePath, error: String(err) })
    throw err
  }
}
