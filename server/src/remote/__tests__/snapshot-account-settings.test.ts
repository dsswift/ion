/**
 * The phone's snapshot carries its OWNER's Account settings.
 *
 * The bug this pins: recent directories are written to a person's overlay,
 * but the snapshot read the shared Environment document. A phone therefore
 * showed directories its owner had already replaced.
 *
 * Revert proof: reading `readSettings()` in `buildSnapshotEvent` returns the
 * Environment values below and fails every assertion.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const paths = vi.hoisted(() => ({ dir: '' }))
vi.mock('../../paths', async (importOriginal) => ({ ...(await importOriginal<object>()), dataDir: () => paths.dir }))
vi.mock('../snapshot', () => ({ getRemoteTabStates: async () => ({ tabs: [], resourceManifest: [] }) }))
vi.mock('../snapshot-settled', () => ({ settledTabsSnapshot: () => undefined }))

import { writeSettingsForSubject } from '../../persistence/user-settings-store'
import { buildSnapshotEvent } from '../snapshot-polling'

beforeEach(() => {
  paths.dir = mkdtempSync(join(tmpdir(), 'ion-snapshot-account-'))
  writeFileSync(join(paths.dir, 'settings.json'), JSON.stringify({ recentBaseDirectories: ['/stale/shared'] }))
  writeSettingsForSubject('user:guest', { recentBaseDirectories: ['/guest/project'] })
})
afterEach(() => rmSync(paths.dir, { recursive: true, force: true }))

describe('buildSnapshotEvent', () => {
  it("reads the subject's overlay for Account settings", async () => {
    const { event } = await buildSnapshotEvent('user:guest')
    expect(event.recentDirectories).toEqual(['/guest/project'])
  })
})
