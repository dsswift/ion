import { basename, join } from 'path'
import { log as _log } from '../../logger'
import { state } from '../../state'
import { runGit } from '../../git-runner'
import { computeGraphLayout } from '../../../shared/gitGraphLayout'
import type { RemoteCommand } from '../protocol'
import type { GitRef } from '../../../shared/types'
import { broadcastGitChanges, broadcastGitGraph } from '../git-broadcast'

function log(msg: string): void {
  _log('main', msg)
}

export async function handleGitChanges(cmd: Extract<RemoteCommand, { type: 'git_changes' }>, deviceId: string): Promise<void> {
  const { directory } = cmd
  try {
    try {
      await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      state.remoteTransport?.sendToDevice(deviceId, { type: 'git_changes_response', directory, files: [], branch: '', isGitRepo: false, ahead: 0, behind: 0 })
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

    const stagedCount = files.filter(f => f.staged).length
    const unstagedCount = files.filter(f => !f.staged).length

    state.remoteTransport?.sendToDevice(deviceId, { type: 'git_changes_response', directory, files, branch, isGitRepo: true, ahead, behind, stagedCount, unstagedCount })
  } catch (err) {
    log(`git_changes error: ${(err as Error).message}`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'git_changes_response', directory, files: [], branch: '', isGitRepo: true, ahead: 0, behind: 0, stagedCount: 0, unstagedCount: 0 })
  }
}

export async function handleGitGraph(cmd: Extract<RemoteCommand, { type: 'git_graph' }>, deviceId: string): Promise<void> {
  const { directory, skip = 0, limit = 100 } = cmd
  try {
    try {
      await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      state.remoteTransport?.sendToDevice(deviceId, { type: 'git_graph_response', directory, commits: [], isGitRepo: false, totalCount: 0 })
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
      const refs: GitRef[] = []
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

    const graphLayout = computeGraphLayout(commits).map(node => ({
      lane: node.lane,
      color: node.color,
      hasIncoming: node.hasIncoming,
      connections: node.connections,
      passThroughLanes: node.passThroughLanes,
    }))

    state.remoteTransport?.sendToDevice(deviceId, { type: 'git_graph_response', directory, commits, isGitRepo: true, totalCount, graphLayout })
  } catch (err) {
    log(`git_graph error: ${(err as Error).message}`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'git_graph_response', directory, commits: [], isGitRepo: true, totalCount: 0 })
  }
}

export async function handleGitDiff(cmd: Extract<RemoteCommand, { type: 'git_diff' }>, deviceId: string): Promise<void> {
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
    state.remoteTransport?.sendToDevice(deviceId, { type: 'git_diff_response', diff, fileName: basename(filePath) })
  } catch (err) {
    log(`git_diff error: ${(err as Error).message}`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'git_diff_response', diff: '', fileName: basename(filePath) })
  }
}

export async function handleGitStage(cmd: Extract<RemoteCommand, { type: 'git_stage' }>): Promise<void> {
  const { directory, paths } = cmd
  let ok = true
  try {
    await runGit(directory, ['add', '--', ...paths])
  } catch (err) {
    log(`git_stage error: ${(err as Error).message}`)
    ok = false
  }
  state.remoteTransport?.send({ type: 'git_stage_result', directory, ok })
  // Auto-refresh changes and broadcast to all devices
  await broadcastGitChanges(directory)
}

export async function handleGitUnstage(cmd: Extract<RemoteCommand, { type: 'git_unstage' }>): Promise<void> {
  const { directory, paths } = cmd
  let ok = true
  try {
    await runGit(directory, ['restore', '--staged', '--', ...paths])
  } catch (err) {
    log(`git_unstage error: ${(err as Error).message}`)
    ok = false
  }
  state.remoteTransport?.send({ type: 'git_unstage_result', directory, ok })
  // Auto-refresh changes and broadcast to all devices
  await broadcastGitChanges(directory)
}

export async function handleGitCommit(cmd: Extract<RemoteCommand, { type: 'git_commit' }>): Promise<void> {
  const { directory, message } = cmd
  let ok = true
  let error: string | undefined
  try {
    await runGit(directory, ['commit', '-m', message])
  } catch (err) {
    log(`git_commit error: ${(err as Error).message}`)
    ok = false
    error = (err as Error).message
  }
  state.remoteTransport?.send({ type: 'git_commit_result', directory, ok, error })
  // Auto-refresh both changes and graph, broadcast to all devices
  await broadcastGitChanges(directory)
  await broadcastGitGraph(directory)
}

export async function handleGitCommitFiles(cmd: Extract<RemoteCommand, { type: 'git_commit_files' }>, deviceId: string): Promise<void> {
  const { directory, hash } = cmd
  try {
    // Run both queries in parallel — both are lightweight index-only reads
    const [statusOutput, numstatOutput] = await Promise.all([
      runGit(directory, ['diff-tree', '--no-commit-id', '-r', '--name-status', hash]),
      runGit(directory, ['diff-tree', '--no-commit-id', '-r', '--numstat', hash]),
    ])

    // Parse name-status for file list + status codes
    const codeMap: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied' }
    const files: Array<{ path: string; status: string; oldPath?: string }> = []
    for (const line of statusOutput.trim().split('\n').filter(Boolean)) {
      const parts = line.split('\t')
      const code = parts[0][0]
      const status = codeMap[code] || 'modified'
      if (code === 'R') {
        files.push({ path: parts[2], status, oldPath: parts[1] })
      } else {
        files.push({ path: parts[1], status })
      }
    }

    // Parse numstat for aggregate stats
    let totalInsertions = 0
    let totalDeletions = 0
    for (const line of numstatOutput.trim().split('\n').filter(Boolean)) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t/)
      if (m) {
        if (m[1] !== '-') totalInsertions += parseInt(m[1], 10)
        if (m[2] !== '-') totalDeletions += parseInt(m[2], 10)
      }
    }

    const stats = { filesChanged: files.length, insertions: totalInsertions, deletions: totalDeletions }
    state.remoteTransport?.sendToDevice(deviceId, { type: 'git_commit_files_response', directory, hash, files, stats })
  } catch (err) {
    log(`git_commit_files error: ${(err as Error).message}`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'git_commit_files_response', directory, hash, files: [], stats: { filesChanged: 0, insertions: 0, deletions: 0 } })
  }
}

export async function handleGitCommitFileDiff(cmd: Extract<RemoteCommand, { type: 'git_commit_file_diff' }>, deviceId: string): Promise<void> {
  const { directory, hash, path: filePath } = cmd
  try {
    const output = await runGit(directory, ['diff-tree', '-p', '--root', hash, '--', filePath])
    const fileName = basename(filePath)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'git_commit_file_diff_response', hash, path: filePath, diff: output, fileName })
  } catch (err) {
    log(`git_commit_file_diff error: ${(err as Error).message}`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'git_commit_file_diff_response', hash, path: filePath, diff: '', fileName: basename(filePath) })
  }
}

export async function handleGitDiscard(cmd: Extract<RemoteCommand, { type: 'git_discard' }>): Promise<void> {
  const { directory, paths } = cmd
  try {
    const statusOutput = await runGit(directory, ['status', '--porcelain=v1', '-uall', '--', ...paths])
    const trackedPaths: string[] = []
    const untrackedPaths: string[] = []
    for (const line of statusOutput.split('\n').filter((l) => l.length >= 4)) {
      const dm = line.match(/^(.)(.) (.+)$/)
      if (!dm) continue
      const x = dm[1]
      const y = dm[2]
      let p = dm[3]
      if (p.includes(' -> ')) p = p.split(' -> ')[1]
      if (x === '?' && y === '?') {
        untrackedPaths.push(p)
      } else {
        trackedPaths.push(p)
      }
    }
    if (trackedPaths.length > 0) {
      await runGit(directory, ['checkout', 'HEAD', '--', ...trackedPaths])
    }
    if (untrackedPaths.length > 0) {
      const { unlink } = require('fs/promises')
      const { join } = require('path')
      for (const p of untrackedPaths) {
        try { await unlink(join(directory, p)) } catch {}
      }
    }
  } catch (err) {
    log(`git_discard error: ${(err as Error).message}`)
  }
  await broadcastGitChanges(directory)
}

export async function handleGitFetch(cmd: Extract<RemoteCommand, { type: 'git_fetch' }>): Promise<void> {
  const { directory } = cmd
  try {
    await runGit(directory, ['fetch', '--all'])
  } catch (err) {
    log(`git_fetch error: ${(err as Error).message}`)
  }
  await broadcastGitChanges(directory)
  await broadcastGitGraph(directory)
}

export async function handleGitPull(cmd: Extract<RemoteCommand, { type: 'git_pull' }>): Promise<void> {
  const { directory } = cmd
  try {
    await runGit(directory, ['pull'])
  } catch (err) {
    log(`git_pull error: ${(err as Error).message}`)
  }
  await broadcastGitChanges(directory)
  await broadcastGitGraph(directory)
}

export async function handleGitPush(cmd: Extract<RemoteCommand, { type: 'git_push' }>): Promise<void> {
  const { directory } = cmd
  try {
    await runGit(directory, ['push'])
  } catch (err) {
    log(`git_push error: ${(err as Error).message}`)
  }
  await broadcastGitGraph(directory)
}
