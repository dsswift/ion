import { log as _log } from '../logger'
import { state } from '../state'
import { runGit } from '../git-runner'
import { computeGraphLayout } from '../../shared/gitGraphLayout'
import type { GitRef } from '../../shared/types'

function log(msg: string): void {
  _log('main', msg)
}

/** Broadcast git changes to all connected devices. */
export async function broadcastGitChanges(directory: string): Promise<void> {
  try {
    try {
      await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      log(`broadcastGitChanges: ${directory} is not a git repo`)
      state.remoteTransport?.send({ type: 'git_changes_response', directory, files: [], branch: '', isGitRepo: false, ahead: 0, behind: 0, stagedCount: 0, unstagedCount: 0 })
      return
    }
    let branch = ''
    try { branch = (await runGit(directory, ['branch', '--show-current'])).trim() } catch {}
    let ahead = 0, behind = 0
    try {
      ahead = parseInt((await runGit(directory, ['rev-list', '--count', '@{upstream}..HEAD'])).trim(), 10) || 0
      behind = parseInt((await runGit(directory, ['rev-list', '--count', 'HEAD..@{upstream}'])).trim(), 10) || 0
    } catch {}
    const statusOutput = await runGit(directory, ['status', '--porcelain=v1', '-uall'])
    const files: Array<{ path: string; status: string; staged: boolean; oldPath?: string }> = []
    for (const line of statusOutput.split('\n').filter((l) => l.length >= 4)) {
      const match = line.match(/^(.)(.) (.+)$/)
      if (!match) continue
      const x = match[1], y = match[2]
      let filePath = match[3]
      let oldPath: string | undefined
      if (filePath.includes(' -> ')) { const parts = filePath.split(' -> '); oldPath = parts[0]; filePath = parts[1] }
      if (x !== ' ' && x !== '?' && x !== '!') {
        let status: string
        if (x === 'A') status = 'added'; else if (x === 'D') status = 'deleted'; else if (x === 'R') status = 'renamed'; else status = 'modified'
        files.push({ path: filePath, status, staged: true, oldPath })
      }
      if (y !== ' ' && y !== '!') {
        let status: string
        if (y === '?') status = 'untracked'; else if (y === 'A') status = 'added'; else if (y === 'D') status = 'deleted'; else if (y === 'R') status = 'renamed'; else status = 'modified'
        files.push({ path: filePath, status, staged: false, oldPath })
      }
    }
    const stagedCount = files.filter(f => f.staged).length
    const unstagedCount = files.filter(f => !f.staged).length
    log(`broadcastGitChanges: ${directory} branch=${branch} ahead=${ahead} behind=${behind} staged=${stagedCount} unstaged=${unstagedCount}`)
    state.remoteTransport?.send({ type: 'git_changes_response', directory, files, branch, isGitRepo: true, ahead, behind, stagedCount, unstagedCount })
  } catch (err) {
    log(`broadcastGitChanges error for ${directory}: ${(err as Error).message}`)
  }
}

/** Broadcast git graph to all connected devices. */
export async function broadcastGitGraph(directory: string): Promise<void> {
  try {
    try {
      await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      log(`broadcastGitGraph: ${directory} is not a git repo`)
      state.remoteTransport?.send({ type: 'git_graph_response', directory, commits: [], isGitRepo: false, totalCount: 0 })
      return
    }
    const format = '%h%x00%H%x00%P%x00%an%x00%aI%x00%s%x00%D'
    const logOutput = await runGit(directory, ['log', '--all', `--format=${format}`, '--topo-order', '-n', '100'])
    let totalCount = 0
    try { totalCount = parseInt((await runGit(directory, ['rev-list', '--all', '--count'])).trim(), 10) || 0 } catch {}
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
    log(`broadcastGitGraph: ${directory} totalCount=${totalCount} commits=${commits.length}`)
    state.remoteTransport?.send({ type: 'git_graph_response', directory, commits, isGitRepo: true, totalCount, graphLayout })
  } catch (err) {
    log(`broadcastGitGraph error for ${directory}: ${(err as Error).message}`)
  }
}
