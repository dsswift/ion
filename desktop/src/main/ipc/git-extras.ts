/**
 * Newer git IPC handlers split out from ipc/git.ts to stay under the file-size cap.
 *
 * Owns subscriptions, patch application, tag creation, file-at-revision read,
 * commit signature verification, and recent-ref history.
 */

import { ipcMain } from 'electron'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { IPC } from '../../shared/types'
import { runGit } from '../git-runner'
import { error as _error } from '../logger'
import { subscribe as gitSubscribe, unsubscribe as gitUnsubscribe } from '../git/subscriptions'
import { repositoryManager } from '../git/repositoryManager'

const logError = (msg: string): void => { _error('git-extras', msg) }

export function registerGitExtrasIpc(): void {
  ipcMain.handle(IPC.GIT_SUBSCRIBE, async (event, { directory }: { directory: string }) => {
    const snapshot = await gitSubscribe(event.sender, directory)
    return { snapshot }
  })

  ipcMain.handle(IPC.GIT_UNSUBSCRIBE, async (event, { directory }: { directory: string }) => {
    gitUnsubscribe(event.sender, directory)
    return { ok: true }
  })

  ipcMain.handle(IPC.GIT_REFRESH, async (_event, { directory }: { directory: string }) => {
    if (!repositoryManager.has(directory)) return { ok: false }
    await repositoryManager.get(directory).refreshSnapshot()
    return { ok: true }
  })

  ipcMain.handle(IPC.GIT_APPLY_PATCH, async (_event, { directory, patch, reverse, cached }: { directory: string; patch: string; reverse?: boolean; cached?: boolean }) => {
    const args = ['apply', '--whitespace=nowarn']
    if (cached) args.push('--cached')
    if (reverse) args.push('-R')
    const tmpPatch = join(tmpdir(), `ion-patch-${process.pid}-${Date.now()}.patch`)
    try {
      writeFileSync(tmpPatch, patch)
      args.push(tmpPatch)
      await runGit(directory, args)
      return { ok: true }
    } catch (err: any) {
      logError(`gitApplyPatch failed: ${err.message}`)
      return { ok: false, error: err.message }
    } finally {
      try { unlinkSync(tmpPatch) } catch {}
    }
  })

  ipcMain.handle(IPC.GIT_TAG_CREATE, async (_event, { directory, name, ref, message }: { directory: string; name: string; ref?: string; message?: string }) => {
    try {
      const args = ['tag']
      if (message) args.push('-a', name, '-m', message)
      else args.push(name)
      if (ref) args.push(ref)
      await runGit(directory, args)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_SHOW_FILE, async (_event, { directory, hash, path }: { directory: string; hash: string; path: string }) => {
    try {
      const content = await runGit(directory, ['show', `${hash}:${path}`])
      return { ok: true, content }
    } catch (err: any) {
      return { ok: false, error: err.message, content: '' }
    }
  })

  ipcMain.handle(IPC.GIT_COMMIT_SIGNATURE, async (_event, { directory, hash }: { directory: string; hash: string }) => {
    try {
      const out = await runGit(directory, ['log', '-1', '--format=%G?\t%GS\t%GK', hash])
      const [status, signer, key] = out.trim().split('\t')
      return { ok: true, status, signer, key }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_RECENT_REFS, async (_event, { directory, limit }: { directory: string; limit?: number }) => {
    try {
      const out = await runGit(directory, ['log', '-g', '--format=%gs', 'HEAD', `-n`, String(limit ?? 100)])
      const refs: string[] = []
      const seen = new Set<string>()
      for (const line of out.split('\n')) {
        const match = line.match(/^checkout: moving from \S+ to (\S+)/)
        if (match) {
          const ref = match[1]
          if (!seen.has(ref)) { seen.add(ref); refs.push(ref) }
        }
      }
      return { ok: true, refs }
    } catch (err: any) {
      return { ok: false, error: err.message, refs: [] }
    }
  })
}
