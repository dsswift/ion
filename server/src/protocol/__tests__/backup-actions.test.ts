/**
 * Pins the `backup.*` surface: explicit archive paths (no dialog lives here),
 * the Environment's data directory as the source, progress on the wire, and
 * the panel-shaped `{ ok: false, error }` on failure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  previewExport: vi.fn(() => ({ conversationCount: 2, totalUncompressedBytes: 10, tabCount: 1 })),
  runExport: vi.fn(async (_args: { onProgress?: (c: number, t: number, l: string) => void }) => ({ ok: true, path: '/out.zip' })),
  previewRestore: vi.fn(async () => ({ ok: true, manifest: { v: 1 } })),
  runRestore: vi.fn(async () => ({ ok: true, restored: 1, skipped: 0, overwritten: 0, renamed: 0, errors: [] })),
  broadcast: vi.fn(),
}))
vi.mock('../../paths', () => ({ dataDir: () => '/data/ion' }))
vi.mock('../../broadcast', () => ({ broadcast: deps.broadcast }))
vi.mock('../../server-version', () => ({ readServerVersion: () => '9.9.9' }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../persistence/settings-store', () => ({
  tabsFile: () => '/data/ion/tabs.json',
  sessionChainsFile: () => '/data/ion/session-chains.json',
  sessionLabelsFile: () => '/data/ion/session-labels.json',
  legacyTabsFileForBackend: (b: string) => `/data/ion/tabs-${b}.json`,
  legacySessionChainsFileForBackend: (b: string) => `/data/ion/session-chains-${b}.json`,
  legacySessionLabelsFileForBackend: (b: string) => `/data/ion/session-labels-${b}.json`,
}))
vi.mock('../../conversation-backup/export', () => ({ previewExport: deps.previewExport, runExport: deps.runExport }))
vi.mock('../../conversation-backup/restore', () => ({ previewRestore: deps.previewRestore, runRestore: deps.runRestore }))

import { BACKUP_ACTIONS } from '../backup-actions'
import type { Connection } from '../connection'

const conn = { id: 'c' } as unknown as Connection
const run = (name: string, ...args: unknown[]) => BACKUP_ACTIONS[name].handler(conn, args)
beforeEach(() => { for (const fn of Object.values(deps)) fn.mockClear() })

describe('BACKUP_ACTIONS', () => {
  it('exportPreview reads the Environment data directory and defaults an unknown scope to currently-open', async () => {
    expect(await run('backup.exportPreview', { scope: 'everything' })).toEqual({ ok: true, value: { ok: true, conversationCount: 2, totalUncompressedBytes: 10, tabCount: 1 } })
    expect(deps.previewExport).toHaveBeenCalledWith({
      scope: 'currently-open',
      sources: expect.objectContaining({ conversationsDir: '/data/ion/conversations', tabsFiles: ['/data/ion/tabs.json', '/data/ion/tabs-api.json', '/data/ion/tabs-cli.json'] }),
    })
  })

  it('export requires an explicit destination and forwards progress onto the wire channel', async () => {
    expect(await run('backup.export', { scope: 'all' })).toEqual({ ok: true, value: { ok: false, error: 'destinationPath required' } })
    expect(deps.runExport).not.toHaveBeenCalled()

    deps.runExport.mockImplementationOnce(async (args: { onProgress?: (c: number, t: number, l: string) => void }) => {
      args.onProgress?.(1, 3, 'a.jsonl')
      return { ok: true, path: '/out.zip' }
    })
    expect(await run('backup.export', { scope: 'all', destinationPath: '/out.zip' })).toEqual({ ok: true, value: { ok: true, path: '/out.zip' } })
    expect(deps.runExport).toHaveBeenCalledWith(expect.objectContaining({ scope: 'all', destinationPath: '/out.zip', ionVersion: '9.9.9' }))
    expect(deps.broadcast).toHaveBeenCalledWith('ion:conversation-backup-progress', { current: 1, total: 3, label: 'a.jsonl' })
  })

  it('restorePreview echoes the source path beside the manifest and refuses a missing one', async () => {
    expect(await run('backup.restorePreview', {})).toEqual({ ok: true, value: { ok: false, error: 'sourcePath required' } })
    expect(await run('backup.restorePreview', { sourcePath: '/in.zip' })).toEqual({ ok: true, value: { ok: true, manifest: { v: 1 }, sourcePath: '/in.zip' } })
  })

  it('restore normalises the conflict policy and restoreTabs, targeting the Environment data directory', async () => {
    expect(await run('backup.restore', { sourcePath: '/in.zip', conflictPolicy: 'explode', restoreTabs: 'yes' })).toMatchObject({ ok: true, value: { ok: true, restored: 1 } })
    expect(deps.runRestore).toHaveBeenCalledWith({
      zipPath: '/in.zip', conflictPolicy: 'skip', restoreTabs: false,
      sources: { conversationsDir: '/data/ion/conversations', ionHomeDir: '/data/ion' },
    })
    expect(await run('backup.restore', { sourcePath: '/in.zip', conflictPolicy: 'rename', restoreTabs: true })).toMatchObject({ ok: true })
    expect(deps.runRestore).toHaveBeenLastCalledWith(expect.objectContaining({ conflictPolicy: 'rename', restoreTabs: true }))
  })

  it('a thrown failure becomes the panel\'s { ok: false, error } rather than a failed action', async () => {
    deps.previewRestore.mockRejectedValueOnce(new Error('not a zip'))
    expect(await run('backup.restorePreview', { sourcePath: '/in.zip' })).toEqual({ ok: true, value: { ok: false, error: 'not a zip' } })
  })

  it('every verb is admin', () => {
    for (const spec of Object.values(BACKUP_ACTIONS)) expect(spec.requiredScope).toBe('admin')
  })
})
