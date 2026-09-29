/**
 * Pins the `fs.*` studio_action scope split.
 *
 * Reads are `conversations:read`; mutations are `git:write`. That scope is
 * named for repository mutation and is the right bar here: the files these
 * verbs create, rename, and delete ARE the working tree, so a client that
 * may not change the repository may not change its files either.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../files/file-api', () => ({
  fsReadDir: vi.fn(() => ({ entries: [] })),
  fsReadFile: vi.fn(() => ({ content: 'x' })),
  fsExists: vi.fn(() => ({ exists: true })),
  fsWatchFile: vi.fn(() => ({ ok: true })),
  fsUnwatchFile: vi.fn(() => ({ ok: true })),
  fsWriteFile: vi.fn(() => ({ ok: true })),
  fsCreateDir: vi.fn(() => ({ ok: true })),
  fsCreateFile: vi.fn(() => ({ ok: true })),
  fsRename: vi.fn(() => ({ ok: true })),
  fsDelete: vi.fn(() => ({ ok: true })),
}))
vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../../files/tree-watch', () => ({
  treeWatch: { watch: vi.fn(() => ({ ok: true })), unwatch: vi.fn(() => ({ ok: true })), unwatchAll: vi.fn(), watchedRoots: vi.fn(() => []) },
}))
vi.mock('../../files/describe-file', () => ({
  describeFile: vi.fn((path: string) => ({ id: 'att-1', type: 'file', name: 'a.txt', path })),
}))

import { FILE_ACTIONS } from '../file-actions'
import * as fileApi from '../../files/file-api'
import { treeWatch } from '../../files/tree-watch'
import type { Connection } from '../connection'

const sent: unknown[] = []
const conn = { id: 'conn-test', scopes: [], send: (frame: unknown) => { sent.push(frame); return true } } as unknown as Connection

describe('FILE_ACTIONS scopes', () => {
  it('keeps reads and watches at conversations:read', () => {
    for (const name of ['fs.readDir', 'fs.readFile', 'fs.exists', 'fs.watchFile', 'fs.unwatchFile', 'fs.watchTree', 'fs.unwatchTree', 'fs.searchFiles', 'fs.searchText']) {
      expect(FILE_ACTIONS[name].requiredScope, name).toBe('conversations:read')
    }
  })

  it('requires git:write for every filesystem mutation', () => {
    for (const name of ['fs.writeFile', 'fs.createDir', 'fs.createFile', 'fs.rename', 'fs.delete']) {
      expect(FILE_ACTIONS[name].requiredScope, name).toBe('git:write')
    }
  })

  it('exposes no native shell verb: save dialog, reveal, and open-with stay Electron-only', () => {
    for (const name of Object.keys(FILE_ACTIONS)) {
      expect(name).not.toMatch(/saveDialog|reveal|openNative/i)
    }
  })
})

describe('FILE_ACTIONS dispatch', () => {
  it('forwards the payload straight through to the shared api', async () => {
    await FILE_ACTIONS['fs.readDir'].handler(conn, [{ directory: '/tmp/x' }])
    expect(fileApi.fsReadDir).toHaveBeenCalledWith({ directory: '/tmp/x' })
  })

  it('answers fs.attachByPath with the attachment row itself, never a nested result', async () => {
    // The client adds the reply to the composer as-is, so a wrapped
    // `{ ok, value }` would become an attachment with no id and no path.
    const outcome = await FILE_ACTIONS['fs.attachByPath'].handler(conn, [{ tabId: 't-1', path: '/work/a.txt' }])
    expect(outcome).toEqual({ ok: true, value: { id: 'att-1', type: 'file', name: 'a.txt', path: '/work/a.txt' } })
  })

  it('keeps fs.readFileData and fs.resolveLink reads', () => {
    expect(FILE_ACTIONS['fs.readFileData'].requiredScope).toBe('conversations:read')
    expect(FILE_ACTIONS['fs.resolveLink'].requiredScope).toBe('conversations:read')
  })

  it('subscribes the calling connection to a tree, and sends its changes to that connection alone', async () => {
    const outcome = await FILE_ACTIONS['fs.watchTree'].handler(conn, [{ root: '/work' }])
    expect(outcome).toEqual({ ok: true, value: { ok: true } })
    const [subscriber, payload] = vi.mocked(treeWatch.watch).mock.calls[0]
    expect(subscriber.id).toBe('conn-test')
    expect(payload).toEqual({ root: '/work' })

    const change = { root: '/work', directories: ['src'], overflow: false, ignoreRulesChanged: false }
    subscriber.send(change)
    expect(sent).toEqual([{ type: 'studio_event', channel: 'ion:fs-tree-changed', payload: change }])

    await FILE_ACTIONS['fs.unwatchTree'].handler(conn, [{ root: '/work' }])
    expect(treeWatch.unwatch).toHaveBeenCalledWith('conn-test', { root: '/work' })
  })

  it('turns a throw into a typed error rather than dropping the reply', async () => {
    vi.mocked(fileApi.fsDelete).mockImplementationOnce(() => { throw new Error('EPERM') })
    const outcome = await FILE_ACTIONS['fs.delete'].handler(conn, [{ targetPath: '/tmp/x' }])
    expect(outcome).toMatchObject({ ok: false, error: { code: 'file_action_failed' } })
  })
})
