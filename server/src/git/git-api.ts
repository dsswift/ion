/**
 * git-api — the git read/write verbs, headless.
 *
 * These bodies used to live inside `desktop/src/main/ipc/git.ts` behind
 * `ipcMain.handle`, which made the whole Git panel Electron-only even though
 * the work is `runGit` invocations and output parsing with nothing
 * window-specific in it. A browser Studio client showed an empty panel and
 * refused every verb, because `gitDirect` was false for want of a transport.
 *
 * The handlers are exported as one channel-keyed table rather than as
 * individual named functions. That keeps this a MECHANICAL relocation of
 * production git code: each entry is the original arrow function verbatim,
 * minus the unused Electron event parameter, so a reader can diff it against
 * the history and see that no behavior moved. `protocol/git-actions.ts` maps
 * studio_action names onto the same table, and the Electron IPC layer
 * registers it directly.
 */
import { unlink } from 'fs/promises'
import { basename, join } from 'path'
import { IPC } from '@ion/shared/types'
import { runGit } from './git-runner'
import { loadCommitFileDiff, loadGitDiff } from './diff-content'
import { writeFileSync } from 'fs'
import { partitionStatus } from './diffs'
import { computeGraphLayout } from '@ion/shared/gitGraphLayout'
import { benchGuard } from '../integration/bench-guard'
import { error as _error, debug as _debug } from '../logger'
import { GIT_OPS_HANDLERS } from './git-api-ops'
import { WORKTREE_GIT_HANDLERS } from './worktree-git-api'

const logError = (msg: string): void => { _error('git-api', msg) }
const logDebug = (msg: string, fields?: Record<string, unknown>): void => { _debug('git-api', msg, fields) }

/** Channel-keyed git handlers. The payload is whatever the matching preload method sends. */
const GIT_READ_WRITE_HANDLERS: Record<string, (payload: any) => Promise<unknown>> = {
  [IPC.GIT_IS_REPO]: async (directory: string) => {
    try {
      await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
      return { isRepo: true }
    } catch {
      return { isRepo: false }
    }
  },

  // `withLayout` adds `graphLayout`, one lane node per commit, for a client that
  // draws the graph without computing lanes itself. Absent, the reply is unchanged.
  [IPC.GIT_GRAPH]: async ({ directory, skip = 0, limit = 100, search, author, path, refKind, dateAfter, dateBefore, withLayout }: { directory: string; skip?: number; limit?: number; search?: string; author?: string; path?: string; refKind?: string; dateAfter?: string; dateBefore?: string; withLayout?: boolean }) => {
    try {
      await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      return { commits: [], isGitRepo: false, totalCount: 0 }
    }

    try {
      const format = '%h%x00%H%x00%P%x00%an%x00%aI%x00%s%x00%D'
      const refScope =
        refKind === 'head' ? ['HEAD']
        : refKind === 'branches' ? ['--branches']
        : refKind === 'tags' ? ['--tags']
        : ['--all']
      const logArgs = [
        'log', ...refScope, `--format=${format}`, '--topo-order',
        `--skip=${skip}`, `-n`, `${limit}`,
      ]
      const countArgs = ['rev-list', ...refScope, '--count']

      if (search) {
        logArgs.push(`--grep=${search}`, '-i')
        countArgs.push(`--grep=${search}`)
      }
      if (author) {
        logArgs.push(`--author=${author}`)
        countArgs.push(`--author=${author}`)
      }
      if (dateAfter) {
        logArgs.push(`--after=${dateAfter}`)
        countArgs.push(`--after=${dateAfter}`)
      }
      if (dateBefore) {
        logArgs.push(`--before=${dateBefore}`)
        countArgs.push(`--before=${dateBefore}`)
      }
      if (path) {
        logArgs.push('--follow', '--', path)
        countArgs.push('--', path)
      }

      const logOutput = await runGit(directory, logArgs)

      let totalCount = 0
      try {
        const countOutput = await runGit(directory, countArgs)
        totalCount = parseInt(countOutput.trim(), 10) || 0
      } catch (err) { logDebug("git: total-count read failed", { directory, error: String(err) }) }

      const commits = logOutput.trim().split('\n').filter(Boolean).map((line) => {
        const [hash, fullHash, parents, authorName, authorDate, subject, decorations] = line.split('\x00')
        const refs: Array<{ name: string; type: 'head' | 'remote' | 'tag'; isCurrent: boolean }> = []
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

      if (!withLayout) return { commits, isGitRepo: true, totalCount }
      const graphLayout = computeGraphLayout(commits).map((node) => ({
        lane: node.lane,
        color: node.color,
        hasIncoming: node.hasIncoming,
        connections: node.connections,
        passThroughLanes: node.passThroughLanes,
      }))
      logDebug('git: graph laid out', { directory, commits: commits.length })
      return { commits, isGitRepo: true, totalCount, graphLayout }
    } catch (err) {
      logDebug('git: graph read failed', { directory, error: String(err) })
      return { commits: [], isGitRepo: true, totalCount: 0 }
    }
  },

  [IPC.GIT_COMMIT_DETAIL]: async ({ directory, hash }: { directory: string; hash: string }) => {
    try {
      const output = await runGit(directory, ['show', '--stat', '--format=', hash])
      const lines = output.trim().split('\n')
      const summary = lines[lines.length - 1] || ''
      const filesMatch = summary.match(/(\d+)\s+files?\s+changed/)
      const insMatch = summary.match(/(\d+)\s+insertions?\(\+\)/)
      const delMatch = summary.match(/(\d+)\s+deletions?\(-\)/)
      return {
        filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
        insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
        deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
      }
    } catch {
      return { filesChanged: 0, insertions: 0, deletions: 0 }
    }
  },

  // `stats` is the numstat aggregate for the same commit. A rename or a copy
  // names both paths: `path` is where the file is now, `oldPath` where it came from.
  [IPC.GIT_COMMIT_FILES]: async ({ directory, hash }: { directory: string; hash: string }) => {
    try {
      const [output, numstatOutput] = await Promise.all([
        runGit(directory, ['diff-tree', '--no-commit-id', '-r', '--name-status', hash]),
        runGit(directory, ['diff-tree', '--no-commit-id', '-r', '--numstat', hash]),
      ])
      const statusMap: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied' }
      const files = output.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t')
        const statusCode = parts[0][0]
        const status = statusMap[statusCode] || 'modified'
        if (statusCode === 'R' || statusCode === 'C') {
          return { path: parts[2], status, oldPath: parts[1] }
        }
        return { path: parts[1], status }
      })
      let insertions = 0
      let deletions = 0
      for (const line of numstatOutput.trim().split('\n').filter(Boolean)) {
        // A binary file reports '-' for both counts and adds nothing.
        const m = line.match(/^(\d+|-)\t(\d+|-)\t/)
        if (!m) continue
        if (m[1] !== '-') insertions += parseInt(m[1], 10)
        if (m[2] !== '-') deletions += parseInt(m[2], 10)
      }
      return { files, stats: { filesChanged: files.length, insertions, deletions } }
    } catch (err) {
      logDebug('git: commit files read failed', { directory, hash, error: String(err) })
      return { files: [], stats: { filesChanged: 0, insertions: 0, deletions: 0 } }
    }
  },

  [IPC.GIT_COMMIT_FILE_DIFF]: async ({ directory, hash, path }: { directory: string; hash: string; path: string }) => {
    try {
      return await loadCommitFileDiff(directory, hash, path)
    } catch (err) {
      logDebug('git: commit file diff failed', { directory, hash, path, error: String(err) })
      return { diff: '', fileName: basename(path), isBinary: false }
    }
  },

  [IPC.GIT_IGNORED_FILES]: async (directory: string) => {
    try {
      const output = await runGit(directory, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])
      const paths = output.trim().split('\n').filter(Boolean).map(p => join(directory, p))
      return { paths }
    } catch {
      return { paths: [] }
    }
  },

  [IPC.GIT_CHANGES]: async ({ directory }: { directory: string }) => {
    try {
      await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      return { files: [], branch: '', isGitRepo: false, ahead: 0, behind: 0, stagedCount: 0, unstagedCount: 0 }
    }

    let branch = ''
    try {
      branch = (await runGit(directory, ["branch", "--show-current"])).trim()
    } catch (err) { logDebug("git: branch read failed", { directory, error: String(err) }) }

    let ahead = 0
    let behind = 0
    try {
      ahead = parseInt((await runGit(directory, ['rev-list', '--count', '@{upstream}..HEAD'])).trim(), 10) || 0
      behind = parseInt((await runGit(directory, ["rev-list", "--count", "HEAD..@{upstream}"])).trim(), 10) || 0
    } catch (err) { logDebug("git: ahead/behind read failed (no upstream?)", { directory, error: String(err) }) }

    try {
      const statusOutput = await runGit(directory, ['status', '--porcelain=v1', '-z', '-uall'])
      const result = partitionStatus(statusOutput).flat
      const stagedCount = result.filter((f) => f.staged).length

      return { files: result, branch, isGitRepo: true, ahead, behind, stagedCount, unstagedCount: result.length - stagedCount }
    } catch (err) {
      logDebug('git: status read failed', { directory, error: String(err) })
      return { files: [], branch, isGitRepo: true, ahead, behind, stagedCount: 0, unstagedCount: 0 }
    }
  },

  [IPC.GIT_COMMIT]: async ({ directory, message, amend, signoff, gpg }: { directory: string; message: string; amend?: boolean; signoff?: boolean; gpg?: boolean }) => {
    const refusal = benchGuard(directory, 'commit')
    if (refusal) return refusal
    try {
      const built = ['commit']
      if (amend) built.push('--amend')
      if (signoff) built.push('--signoff')
      if (gpg) built.push('-S')
      built.push('-m', message)
      await runGit(directory, built)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  },

  [IPC.GIT_FETCH]: async ({ directory }: { directory: string }) => {
    try {
      await runGit(directory, ['fetch', '--all'])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  },

  [IPC.GIT_PULL]: async ({ directory }: { directory: string }) => {
    const refusal = benchGuard(directory, 'pull')
    if (refusal) return refusal
    try {
      await runGit(directory, ['pull'])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  },

  [IPC.GIT_PUSH]: async ({ directory }: { directory: string }) => {
    const refusal = benchGuard(directory, 'push')
    if (refusal) return refusal
    try {
      await runGit(directory, ['push'])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  },

  // `localOnly` answers with the local branch NAMES and nothing else: what a
  // branch picker offers, with no remotes to filter out and no upstreams to carry.
  [IPC.GIT_BRANCHES]: async ({ directory, localOnly }: { directory: string; localOnly?: boolean }) => {
    if (localOnly) {
      try {
        const [branchesOutput, currentBranch] = await Promise.all([
          runGit(directory, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
          runGit(directory, ['branch', '--show-current']),
        ])
        const branches = branchesOutput.split('\n').map((b) => b.trim()).filter(Boolean)
        logDebug('git: local branches read', { directory, count: branches.length })
        return { branches, current: currentBranch.trim() }
      } catch (err) {
        logDebug('git: local branches read failed', { directory, error: String(err) })
        return { branches: [], current: '', error: String(err) }
      }
    }
    try {
      const output = await runGit(directory, [
        'branch', '-a', '--format=%(refname:short)\t%(HEAD)\t%(upstream:short)',
      ])
      let current = ''
      const branches: Array<{ name: string; isCurrent: boolean; upstream: string | null; isRemote: boolean }> = []
      for (const line of output.trim().split('\n').filter(Boolean)) {
        const [name, head, upstream] = line.split('\t')
        const isCurrent = head === '*'
        if (isCurrent) current = name
        const isRemote = name.startsWith('origin/') || name.includes('/')
        branches.push({ name, isCurrent, upstream: upstream || null, isRemote })
      }
      return { branches, current }
    } catch {
      return { branches: [], current: '' }
    }
  },

  [IPC.GIT_CHECKOUT]: async ({ directory, branch }: { directory: string; branch: string }) => {
    const refusal = benchGuard(directory, 'switch branches')
    if (refusal) return refusal
    try {
      await runGit(directory, ['checkout', branch])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  },

  [IPC.GIT_CREATE_BRANCH]: async ({ directory, name }: { directory: string; name: string }) => {
    const refusal = benchGuard(directory, 'create a branch')
    if (refusal) return refusal
    try {
      await runGit(directory, ['checkout', '-b', name])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  },

  [IPC.GIT_DIFF]: async ({ directory, path, staged }: { directory: string; path: string; staged: boolean }) => {
    try {
      return await loadGitDiff(directory, path, staged)
    } catch (err) {
      logDebug('git: diff failed', { directory, path, staged, error: String(err) })
      return { diff: '', fileName: basename(path), isBinary: false }
    }
  },

  [IPC.GIT_STAGE]: async ({ directory, paths }: { directory: string; paths: string[] }) => {
    try {
      await runGit(directory, ['add', '--', ...paths])
      return { ok: true }
    } catch (err: any) {
      logError(`stage failed: ${err.message}`)
      return { ok: false, error: err.message }
    }
  },

  [IPC.GIT_UNSTAGE]: async ({ directory, paths }: { directory: string; paths: string[] }) => {
    try {
      await runGit(directory, ['restore', '--staged', '--', ...paths])
      return { ok: true }
    } catch (err: any) {
      logError(`unstage failed: ${err.message}`)
      return { ok: false, error: err.message }
    }
  },

  [IPC.GIT_DISCARD]: async ({ directory, paths }: { directory: string; paths: string[] }) => {
    try {
      const statusOutput = await runGit(directory, ['status', '--porcelain=v1', '-z', '-uall', '--', ...paths])
      const groups = partitionStatus(statusOutput)
      const untrackedPaths = groups.untracked.map((file) => file.path)
      const trackedPaths = groups.flat
        .filter((file) => file.status !== 'untracked')
        .map((file) => file.path)
      if (trackedPaths.length > 0) {
        await runGit(directory, ['checkout', 'HEAD', '--', ...trackedPaths])
      }
      if (untrackedPaths.length > 0) {
        for (const p of untrackedPaths) {
          try {
            await unlink(join(directory, p))
          } catch (err) {
            // A failed unlink means a file the user asked to discard wasn't
            // removed — log so the partial discard is visible.
            logDebug('git: discard unlink failed', { path: p, error: String(err) })
          }
        }
      }
      return { ok: true }
    } catch (err: any) {
      logError(`discard failed: ${err.message}`)
      return { ok: false, error: err.message }
    }
  },

  [IPC.GIT_DELETE_BRANCH]: async ({ directory, branch }: { directory: string; branch: string }) => {
    const refusal = benchGuard(directory, 'delete a branch')
    if (refusal) return refusal
    try {
      await runGit(directory, ['branch', '-d', branch])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  },

  [IPC.GIT_STASH_LIST]: async ({ directory }: { directory: string }) => {
    try {
      const output = await runGit(directory, ['stash', 'list', '--format=%gd%x00%s%x00%aI%x00%P'])
      const stashes = output.trim().split('\n').filter(Boolean).map((line) => {
        const [ref, message, date, parents] = line.split('\x00')
        const parentSha = (parents ?? '').split(' ').filter(Boolean)[0] ?? ''
        return { ref, message, date, parentSha }
      })
      return { stashes }
    } catch { return { stashes: [] } }
  },

  [IPC.GIT_STASH_SAVE]: async ({ directory, message }: { directory: string; message?: string }) => {
    const refusal = benchGuard(directory, 'stash')
    if (refusal) return refusal
    try {
      const args = message ? ['stash', 'push', '-m', message] : ['stash', 'push']
      await runGit(directory, args)
      return { ok: true }
    } catch (err: any) { return { ok: false, error: err.message } }
  },

  [IPC.GIT_STASH_POP]: async ({ directory, ref }: { directory: string; ref?: string }) => {
    const refusal = benchGuard(directory, 'pop a stash')
    if (refusal) return refusal
    try {
      const args = ref ? ['stash', 'pop', ref] : ['stash', 'pop']
      await runGit(directory, args)
      return { ok: true }
    } catch (err: any) { return { ok: false, error: err.message } }
  },

  [IPC.GIT_STASH_DROP]: async ({ directory, ref }: { directory: string; ref: string }) => {
    const refusal = benchGuard(directory, 'drop a stash')
    if (refusal) return refusal
    try {
      await runGit(directory, ['stash', 'drop', ref])
      return { ok: true }
    } catch (err: any) { return { ok: false, error: err.message } }
  },

  [IPC.GIT_CHERRY_PICK]: async ({ directory, hash }: { directory: string; hash: string }) => {
    const refusal = benchGuard(directory, 'cherry-pick')
    if (refusal) return refusal
    try {
      await runGit(directory, ['cherry-pick', hash])
      return { ok: true }
    } catch (err: any) { return { ok: false, error: err.message } }
  },

  [IPC.GIT_REVERT]: async ({ directory, hash }: { directory: string; hash: string }) => {
    const refusal = benchGuard(directory, 'revert')
    if (refusal) return refusal
    try {
      await runGit(directory, ['revert', '--no-edit', hash])
      return { ok: true }
    } catch (err: any) { return { ok: false, error: err.message } }
  },

  [IPC.GIT_RESET]: async ({ directory, hash, mode }: { directory: string; hash: string; mode: 'soft' | 'mixed' | 'hard' }) => {
    const refusal = benchGuard(directory, 'reset')
    if (refusal) return refusal
    try {
      await runGit(directory, ['reset', `--${mode}`, hash])
      return { ok: true }
    } catch (err: any) { return { ok: false, error: err.message } }
  },

  [IPC.GIT_BLAME]: async ({ directory, path }: { directory: string; path: string }) => {
    try {
      const output = await runGit(directory, ['blame', '--porcelain', path])
      const lines: Array<{ hash: string; author: string; date: string; lineNo: number; content: string }> = []
      const commits: Record<string, { hash: string; author: string; date: string }> = {}
      const rawLines = output.split('\n')
      let i = 0
      while (i < rawLines.length) {
        const headerMatch = rawLines[i].match(/^([0-9a-f]{40}) \d+ (\d+)/)
        if (!headerMatch) { i++; continue }
        const hash = headerMatch[1]
        const lineNo = parseInt(headerMatch[2], 10)
        i++
        while (i < rawLines.length && !rawLines[i].startsWith('\t')) {
          const line = rawLines[i]
          if (line.startsWith('author ')) {
            if (!commits[hash]) commits[hash] = { hash: hash.slice(0, 7), author: '', date: '' }
            commits[hash].author = line.slice(7)
          } else if (line.startsWith('author-time ')) {
            if (!commits[hash]) commits[hash] = { hash: hash.slice(0, 7), author: '', date: '' }
            commits[hash].date = new Date(parseInt(line.slice(12), 10) * 1000).toISOString()
          }
          i++
        }
        const content = i < rawLines.length ? rawLines[i].slice(1) : ''
        i++
        if (commits[hash]) {
          lines.push({ hash: commits[hash].hash, author: commits[hash].author, date: commits[hash].date, lineNo, content })
        }
      }
      return { lines, ok: true }
    } catch (err: any) {
      return { lines: [], ok: false, error: err.message }
    }
  },

  [IPC.GIT_RESOLVE_CONFLICT]: async ({ directory, path, content }: { directory: string; path: string; content: string }) => {
    try {
      const fullPath = join(directory, path)
      writeFileSync(fullPath, content, 'utf-8')
      await runGit(directory, ['add', '--', path])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  },
}

/**
 * Every git verb, read/write plus operations, in one channel-keyed table.
 *
 * Both hosts register from this: Electron loops it onto `ipcMain.handle`,
 * and `protocol/git-actions.ts` maps studio_action names onto it. A verb
 * added to either half is reachable from both without a second edit.
 */
export const GIT_HANDLERS: Record<string, (payload: any) => Promise<unknown>> = {
  ...GIT_READ_WRITE_HANDLERS,
  ...GIT_OPS_HANDLERS,
  ...(WORKTREE_GIT_HANDLERS as Record<string, (payload: any) => Promise<unknown>>),
}
