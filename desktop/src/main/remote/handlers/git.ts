import { basename, join } from 'path'
import { log as _log } from '../../logger'
import { state } from '../../state'
import { runGit } from '../../git-runner'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

export async function handleGitChanges(cmd: Extract<RemoteCommand, { type: 'git_changes' }>): Promise<void> {
  const { directory } = cmd
  try {
    try {
      await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      state.remoteTransport?.send({ type: 'git_changes_response', directory, files: [], branch: '', isGitRepo: false, ahead: 0, behind: 0 })
      return
    }

    let branch = ''
    try {
      branch = (await runGit(directory, ['branch', '--show-current'])).trim()
    } catch {}

    let ahead = 0
    let behind = 0
    try {
      ahead = parseInt((await runGit(directory, ['rev-list', '--count', '@{upstream}..HEAD'])).trim(), 10) || 0
      behind = parseInt((await runGit(directory, ['rev-list', '--count', 'HEAD..@{upstream}'])).trim(), 10) || 0
    } catch {}

    const statusOutput = await runGit(directory, ['status', '--porcelain=v1', '-uall'])
    const files: Array<{ path: string; status: string; staged: boolean; oldPath?: string }> = []
    for (const line of statusOutput.split('\n').filter((l) => l.length >= 4)) {
      const match = line.match(/^(.)(.) (.+)$/)
      if (!match) continue
      const x = match[1]
      const y = match[2]
      let filePath = match[3]
      let oldPath: string | undefined
      if (filePath.includes(' -> ')) {
        const parts = filePath.split(' -> ')
        oldPath = parts[0]
        filePath = parts[1]
      }

      if (x !== ' ' && x !== '?' && x !== '!') {
        let status: string
        if (x === 'A') status = 'added'
        else if (x === 'D') status = 'deleted'
        else if (x === 'R') status = 'renamed'
        else status = 'modified'
        files.push({ path: filePath, status, staged: true, oldPath })
      }
      if (y !== ' ' && y !== '!') {
        let status: string
        if (y === '?') status = 'untracked'
        else if (y === 'A') status = 'added'
        else if (y === 'D') status = 'deleted'
        else if (y === 'R') status = 'renamed'
        else status = 'modified'
        files.push({ path: filePath, status, staged: false, oldPath })
      }
    }

    state.remoteTransport?.send({ type: 'git_changes_response', directory, files, branch, isGitRepo: true, ahead, behind })
  } catch (err) {
    log(`git_changes error: ${(err as Error).message}`)
    state.remoteTransport?.send({ type: 'git_changes_response', directory, files: [], branch: '', isGitRepo: true, ahead: 0, behind: 0 })
  }
}

export async function handleGitGraph(cmd: Extract<RemoteCommand, { type: 'git_graph' }>): Promise<void> {
  const { directory, skip = 0, limit = 100 } = cmd
  try {
    try {
      await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      state.remoteTransport?.send({ type: 'git_graph_response', directory, commits: [], isGitRepo: false, totalCount: 0 })
      return
    }

    const format = '%h%x00%H%x00%P%x00%an%x00%aI%x00%s%x00%D'
    const logOutput = await runGit(directory, [
      'log', '--all', `--format=${format}`, '--topo-order',
      `--skip=${skip}`, `-n`, `${limit}`,
    ])

    let totalCount = 0
    try {
      const countOutput = await runGit(directory, ['rev-list', '--all', '--count'])
      totalCount = parseInt(countOutput.trim(), 10) || 0
    } catch {}

    const commits = logOutput.trim().split('\n').filter(Boolean).map((line) => {
      const [hash, fullHash, parents, authorName, authorDate, subject, decorations] = line.split('\x00')
      const refs: Array<{ name: string; type: string; isCurrent: boolean }> = []
      if (decorations && decorations.trim()) {
        for (const dec of decorations.split(',')) {
          const d = dec.trim()
          if (!d) continue
          if (d.startsWith('HEAD -> ')) {
            refs.push({ name: d.replace('HEAD -> ', ''), type: 'head', isCurrent: true })
          } else if (d.startsWith('tag: ')) {
            refs.push({ name: d.replace('tag: ', ''), type: 'tag', isCurrent: false })
          } else if (d.includes('/')) {
            refs.push({ name: d, type: 'remote', isCurrent: false })
          } else if (d !== 'HEAD') {
            refs.push({ name: d, type: 'head', isCurrent: false })
          }
        }
      }
      return {
        hash,
        fullHash,
        parents: parents ? parents.split(' ') : [],
        authorName,
        authorDate,
        subject,
        refs,
      }
    })

    state.remoteTransport?.send({ type: 'git_graph_response', directory, commits, isGitRepo: true, totalCount })
  } catch (err) {
    log(`git_graph error: ${(err as Error).message}`)
    state.remoteTransport?.send({ type: 'git_graph_response', directory, commits: [], isGitRepo: true, totalCount: 0 })
  }
}

export async function handleGitDiff(cmd: Extract<RemoteCommand, { type: 'git_diff' }>): Promise<void> {
  const { directory, path: filePath, staged } = cmd
  try {
    let diff: string
    if (staged) {
      diff = await runGit(directory, ['diff', '--cached', '--', filePath])
    } else {
      diff = await runGit(directory, ['diff', '--', filePath])
      if (!diff.trim()) {
        try {
          const { readFileSync } = require('fs')
          const fullPath = join(directory, filePath)
          const content = readFileSync(fullPath, 'utf-8')
          const lines = content.split('\n')
          diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n` +
            lines.map((l: string) => `+${l}`).join('\n')
        } catch {
          diff = ''
        }
      }
    }
    state.remoteTransport?.send({ type: 'git_diff_response', diff, fileName: basename(filePath) })
  } catch (err) {
    log(`git_diff error: ${(err as Error).message}`)
    state.remoteTransport?.send({ type: 'git_diff_response', diff: '', fileName: basename(filePath) })
  }
}

export async function handleGitStage(cmd: Extract<RemoteCommand, { type: 'git_stage' }>): Promise<void> {
  const { directory, paths } = cmd
  try {
    await runGit(directory, ['add', '--', ...paths])
  } catch (err) {
    log(`git_stage error: ${(err as Error).message}`)
  }
  // Auto-refresh changes
  await handleGitChanges({ type: 'git_changes', directory })
}

export async function handleGitUnstage(cmd: Extract<RemoteCommand, { type: 'git_unstage' }>): Promise<void> {
  const { directory, paths } = cmd
  try {
    await runGit(directory, ['restore', '--staged', '--', ...paths])
  } catch (err) {
    log(`git_unstage error: ${(err as Error).message}`)
  }
  // Auto-refresh changes
  await handleGitChanges({ type: 'git_changes', directory })
}

export async function handleGitCommit(cmd: Extract<RemoteCommand, { type: 'git_commit' }>): Promise<void> {
  const { directory, message } = cmd
  try {
    await runGit(directory, ['commit', '-m', message])
  } catch (err) {
    log(`git_commit error: ${(err as Error).message}`)
  }
  // Auto-refresh both changes and graph
  await handleGitChanges({ type: 'git_changes', directory })
  await handleGitGraph({ type: 'git_graph', directory })
}
