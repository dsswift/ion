import { log as _log, debug as _debug } from '../logger'
import { state } from '../state'
import { runGit } from '../git-runner'
import { partitionStatus } from '../git/diffs'
import { computeGraphLayout } from '../../shared/gitGraphLayout'
import type { GitRef } from '../../shared/types'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
}

/** Broadcast git changes to all connected devices. */
export async function broadcastGitChanges(directory: string): Promise<void> {
  try {
    try {
      await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      log('git_changes: not a git repo', { dir: directory })
      state.remoteTransport?.send({ type: 'desktop_git_changes_response', directory, files: [], branch: '', isGitRepo: false, ahead: 0, behind: 0, stagedCount: 0, unstagedCount: 0 })
      return
    }
    let branch = ''
    try { branch = (await runGit(directory, ['branch', '--show-current'])).trim() } catch (err) { debug('git_changes: branch read failed', { dir: directory, error: String(err) }) }
    let ahead = 0, behind = 0
    try {
      ahead = parseInt((await runGit(directory, ['rev-list', '--count', '@{upstream}..HEAD'])).trim(), 10) || 0
      behind = parseInt((await runGit(directory, ['rev-list', '--count', 'HEAD..@{upstream}'])).trim(), 10) || 0
    } catch (err) { debug('git_changes: ahead/behind read failed (no upstream?)', { dir: directory, error: String(err) }) }
    const statusOutput = await runGit(directory, ['status', '--porcelain=v1', '-z', '-uall'])
    const files = partitionStatus(statusOutput).flat
    const stagedCount = files.filter(f => f.staged).length
    const unstagedCount = files.filter(f => !f.staged).length
    log('git_changes', { dir: directory, branch, ahead, behind, staged: stagedCount, unstaged: unstagedCount })
    state.remoteTransport?.send({ type: 'desktop_git_changes_response', directory, files, branch, isGitRepo: true, ahead, behind, stagedCount, unstagedCount })
  } catch (err) {
    log('git_changes error', { dir: directory, error: (err as Error).message })
  }
}

/** Broadcast git graph to all connected devices. */
export async function broadcastGitGraph(directory: string): Promise<void> {
  try {
    try {
      await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      log('git_graph: not a git repo', { dir: directory })
      state.remoteTransport?.send({ type: 'desktop_git_graph_response', directory, commits: [], isGitRepo: false, totalCount: 0 })
      return
    }
    const format = '%h%x00%H%x00%P%x00%an%x00%aI%x00%s%x00%D'
    const logOutput = await runGit(directory, ['log', '--all', `--format=${format}`, '--topo-order', '-n', '100'])
    let totalCount = 0
    try { totalCount = parseInt((await runGit(directory, ['rev-list', '--all', '--count'])).trim(), 10) || 0 } catch (err) { debug('git_graph: total-count read failed', { dir: directory, error: String(err) }) }
    const commits = logOutput.trim().split('\n').filter(Boolean).map((line) => {
      const [hash, fullHash, parents, authorName, authorDate, subject, decorations] = line.split('\x00')
      const refs: GitRef[] = []
      if (decorations && decorations.trim()) {
        for (const dec of decorations.split(',')) {
          const d = dec.trim()
          if (!d) continue
          if (d.startsWith('HEAD -> ')) refs.push({ name: d.replace('HEAD -> ', ''), type: 'head', isCurrent: true })
          else if (d.startsWith('tag: ')) refs.push({ name: d.replace('tag: ', ''), type: 'tag', isCurrent: false })
          else if (d.includes('/')) refs.push({ name: d, type: 'remote', isCurrent: false })
          else if (d !== 'HEAD') refs.push({ name: d, type: 'head', isCurrent: false })
        }
      }
      return { hash, fullHash, parents: parents ? parents.split(' ') : [], authorName, authorDate, subject, refs }
    })
    const graphLayout = computeGraphLayout(commits).map(node => ({
      lane: node.lane,
      color: node.color,
      hasIncoming: node.hasIncoming,
      connections: node.connections,
      passThroughLanes: node.passThroughLanes,
    }))
    log('git_graph', { dir: directory, total_count: totalCount, commits: commits.length })
    state.remoteTransport?.send({ type: 'desktop_git_graph_response', directory, commits, isGitRepo: true, totalCount, graphLayout })
  } catch (err) {
    log('git_graph error', { dir: directory, error: (err as Error).message })
  }
}
