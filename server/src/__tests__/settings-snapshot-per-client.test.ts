/**
 * The projected settings a phone renders are ITS person's values, and the
 * snapshot says whether it may change the server's Environment settings.
 *
 * The bug this pins: the projection read the shared Environment document
 * while Studio wrote personal keys to the caller's overlay, so the phone
 * showed values its owner had already replaced.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const paths = vi.hoisted(() => ({ dir: '' }))
vi.mock('../paths', async (importOriginal) => ({ ...(await importOriginal<object>()), dataDir: () => paths.dir }))

import { writeSettingsForSubject } from '../persistence/user-settings-store'
import { buildDesktopSettingsSnapshot } from '../settings-broadcast'

beforeEach(() => {
  paths.dir = mkdtempSync(join(tmpdir(), 'ion-settings-snapshot-'))
  writeFileSync(join(paths.dir, 'settings.json'), JSON.stringify({ inboxAutoSettleDays: 7, gitOpsMode: 'manual' }))
  writeSettingsForSubject('user:guest', { gitOpsMode: 'worktree' })
})
afterEach(() => rmSync(paths.dir, { recursive: true, force: true }))

describe('buildDesktopSettingsSnapshot', () => {
  it("projects the subject's own Account values over the Environment document", () => {
    const guest = buildDesktopSettingsSnapshot('user:guest', ['conversations:read'], null)
    const host = buildDesktopSettingsSnapshot('local:host', ['admin'], null)
    expect(guest.settings.gitOpsMode).toBe('worktree')
    expect(host.settings.gitOpsMode).toBe('manual')
    // One value for the whole server, the same for everyone.
    expect(guest.settings.inboxAutoSettleDays).toBe(7)
    expect(host.settings.inboxAutoSettleDays).toBe(7)
  })

  it('says who may manage the Environment, and marks which entries that governs', () => {
    expect(buildDesktopSettingsSnapshot('user:guest', ['conversations:read', 'git:write'], null).canManageEnvironment).toBe(false)
    const host = buildDesktopSettingsSnapshot('local:host', ['admin'], null)
    expect(host.canManageEnvironment).toBe(true)
    const scopeOf = (key: string) => host.schema.find((entry) => entry.key === key)?.scope
    expect(scopeOf('inboxAutoSettleDays')).toBe('environment')
    expect(scopeOf('gitOpsMode')).toBe('account')
  })

  it('lists the settings pages and places every schema entry on one of them', () => {
    const snapshot = buildDesktopSettingsSnapshot('local:host', ['admin'], null)
    const sections = new Map(snapshot.pages.flatMap((p) => p.sections.map((s) => [s.id, p.id] as const)))
    for (const entry of snapshot.schema) expect(entry.section && sections.get(entry.section), entry.key).toBe(entry.page)
    const gitOps = snapshot.schema.find((entry) => entry.key === 'gitOpsMode')
    expect({ page: gitOps?.page, section: gitOps?.section, group: gitOps?.group }).toEqual({ page: 'workflow', section: 'git', group: 'git' })
  })
})
