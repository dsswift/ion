import { ipcMain } from 'electron'
import { unlink } from 'fs/promises'
import { basename, join } from 'path'
import { IPC } from '../../shared/types'
import { runGit } from '../git-runner'

export function registerGitIpc(): void {
  ipcMain.handle(IPC.GIT_IS_REPO, async (_event, directory: string) => {
    try {
      await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
      return { isRepo: true }
    } catch {
      return { isRepo: false }
    }
  })

  ipcMain.handle(IPC.GIT_GRAPH, async (_event, { directory, skip = 0, limit = 100 }: { directory: string; skip?: number; limit?: number }) => {
    try {
      await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      return { commits: [], isGitRepo: false, totalCount: 0 }
    }

    try {
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

      return { commits, isGitRepo: true, totalCount }
    } catch {
      return { commits: [], isGitRepo: true, totalCount: 0 }
    }
  })

  ipcMain.handle(IPC.GIT_COMMIT_DETAIL, async (_event, { directory, hash }: { directory: string; hash: string }) => {
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
  })

  ipcMain.handle(IPC.GIT_COMMIT_FILES, async (_event, { directory, hash }: { directory: string; hash: string }) => {
    try {
      const output = await runGit(directory, ['diff-tree', '--no-commit-id', '-r', '--name-status', hash])
      const files = output.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t')
        const statusCode = parts[0][0]
        const statusMap: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' }
        const status = statusMap[statusCode] || 'modified'
        if (statusCode === 'R') {
          return { path: parts[2], status, oldPath: parts[1] }
        }
        return { path: parts[1], status }
      })
      return { files }
    } catch {
      return { files: [] }
    }
  })

  ipcMain.handle(IPC.GIT_COMMIT_FILE_DIFF, async (_event, { directory, hash, path }: { directory: string; hash: string; path: string }) => {
    try {
      const output = await runGit(directory, ['diff-tree', '-p', '--root', hash, '--', path])
      const fileName = path.split('/').pop() || path
      return { diff: output, fileName }
    } catch {
      return { diff: '', fileName: path.split('/').pop() || path }
    }
  })

  ipcMain.handle(IPC.GIT_IGNORED_FILES, async (_event, directory: string) => {
    try {
      const output = await runGit(directory, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])
      const paths = output.trim().split('\n').filter(Boolean).map(p => join(directory, p))
      return { paths }
    } catch {
      return { paths: [] }
    }
  })

  ipcMain.handle(IPC.GIT_CHANGES, async (_event, { directory }: { directory: string }) => {
    try {
      await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      return { files: [], branch: '', isGitRepo: false, ahead: 0, behind: 0 }
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

    try {
      const statusOutput = await runGit(directory, ['status', '--porcelain=v1', '-uall'])

      const result: Array<{ path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'; staged: boolean; oldPath?: string }> = []
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
          let status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
          if (x === 'A') status = 'added'
          else if (x === 'D') status = 'deleted'
          else if (x === 'R') status = 'renamed'
          else status = 'modified'
          result.push({ path: filePath, status, staged: true, oldPath })
        }
        if (y !== ' ' && y !== '!') {
          let status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
          if (y === '?') status = 'untracked'
          else if (y === 'A') status = 'added'
          else if (y === 'D') status = 'deleted'
          else if (y === 'R') status = 'renamed'
          else status = 'modified'
          result.push({ path: filePath, status, staged: false, oldPath })
        }
      }

      return { files: result, branch, isGitRepo: true, ahead, behind }
    } catch {
      return { files: [], branch, isGitRepo: true, ahead, behind }
    }
  })

  ipcMain.handle(IPC.GIT_COMMIT, async (_event, { directory, message }: { directory: string; message: string }) => {
    try {
      await runGit(directory, ['commit', '-m', message])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_FETCH, async (_event, { directory }: { directory: string }) => {
    try {
      await runGit(directory, ['fetch', '--all'])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_PULL, async (_event, { directory }: { directory: string }) => {
    try {
      await runGit(directory, ['pull'])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_PUSH, async (_event, { directory }: { directory: string }) => {
    try {
      await runGit(directory, ['push'])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_BRANCHES, async (_event, { directory }: { directory: string }) => {
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
  })

  ipcMain.handle(IPC.GIT_CHECKOUT, async (_event, { directory, branch }: { directory: string; branch: string }) => {
    try {
      await runGit(directory, ['checkout', branch])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_CREATE_BRANCH, async (_event, { directory, name }: { directory: string; name: string }) => {
    try {
      await runGit(directory, ['checkout', '-b', name])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_DIFF, async (_event, { directory, path, staged }: { directory: string; path: string; staged: boolean }) => {
    try {
      let diff: string
      if (staged) {
        diff = await runGit(directory, ['diff', '--cached', '--', path])
      } else {
        diff = await runGit(directory, ['diff', '--', path])
        if (!diff.trim()) {
          try {
            const { readFileSync } = require('fs')
            const fullPath = join(directory, path)
            const content = readFileSync(fullPath, 'utf-8')
            const lines = content.split('\n')
            diff = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` +
              lines.map((l: string) => `+${l}`).join('\n')
          } catch {
            diff = ''
          }
        }
      }
      return { diff, fileName: basename(path) }
    } catch {
      return { diff: '', fileName: basename(path) }
    }
  })

  ipcMain.handle(IPC.GIT_STAGE, async (_event, { directory, paths }: { directory: string; paths: string[] }) => {
    try {
      await runGit(directory, ['add', '--', ...paths])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_UNSTAGE, async (_event, { directory, paths }: { directory: string; paths: string[] }) => {
    try {
      await runGit(directory, ['restore', '--staged', '--', ...paths])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_DISCARD, async (_event, { directory, paths }: { directory: string; paths: string[] }) => {
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
        for (const p of untrackedPaths) {
          try {
            await unlink(join(directory, p))
          } catch {}
        }
      }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_DELETE_BRANCH, async (_event, { directory, branch }: { directory: string; branch: string }) => {
    try {
      await runGit(directory, ['branch', '-d', branch])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
}
