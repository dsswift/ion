/**
 * Both ends of a transfer report the archive format they write, so the
 * dialog can refuse a mismatch before the source exports anything. Pinned
 * here on the destination's early answer, the one a destination with no
 * project for the repository gives, which once left the field out.
 */
import { describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'fs'
import { makeTestPaths } from './fixtures'
import type { Connection } from '../../protocol/connection'

const { paths } = vi.hoisted(() => ({ paths: { current: null as null | ReturnType<typeof import('./fixtures').makeTestPaths> } }))
vi.mock('../paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../paths')>()),
  defaultTransferPaths: () => paths.current!,
}))

import { TRANSFER_ACTIONS } from '../actions'
import { TRANSFER_MANIFEST_VERSION } from '../manifest'

const conn = { id: 'c', scopes: ['admin'], send: () => true } as unknown as Connection

describe('transfer.preflight reports the archive format', () => {
  it('even when it has no project for the repository', async () => {
    paths.current = makeTestPaths('archive-version')
    writeFileSync(paths.current.settingsFile, JSON.stringify({ projects: {} }))
    const none = await TRANSFER_ACTIONS['transfer.preflight'].handler(conn, [{ repoRemote: 'github.com/o/missing' }])
    expect(none).toMatchObject({ ok: true, value: { projectDir: null, archiveVersion: TRANSFER_MANIFEST_VERSION } })
  })
})
