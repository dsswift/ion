/**
 * Pins per-identity settings overlays.
 *
 * Context: `settings.json` is one document for the environment, which is
 * right for the Electron desktop and wrong for a server with browser
 * clients. A browser client had no writable settings at all, so disabling
 * the tab strip and reloading brought it back.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
vi.mock('../paths', () => ({ dataDir: () => dir }))

import { readSettingsForSubject, writeSettingsForSubject } from './user-settings-store'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-user-settings-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ studioSound: true, uiZoom: 1 }))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('readSettingsForSubject', () => {
  it('returns environment settings when the subject has no overlay yet', () => {
    expect(readSettingsForSubject('user-a')).toMatchObject({ studioSound: true, uiZoom: 1 })
  })

  it('applies the subject overlay over the environment defaults', () => {
    writeSettingsForSubject('user-a', { studioSound: false })
    const s = readSettingsForSubject('user-a')
    expect(s.studioSound).toBe(false)
    // Untouched keys still follow the environment.
    expect(s.uiZoom).toBe(1)
  })

  it('keeps one identity out of another identity UI', () => {
    writeSettingsForSubject('user-a', { studioSound: false })
    expect(readSettingsForSubject('user-b').studioSound).toBe(true)
  })

  it('survives a corrupt overlay by falling back to the environment', () => {
    writeSettingsForSubject('user-a', { uiZoom: 2 })
    const file = readdirSync(join(dir, 'user-settings'))[0]
    writeFileSync(join(dir, 'user-settings', file), '{ not json')
    expect(readSettingsForSubject('user-a').uiZoom).toBe(1)
  })
})

describe('writeSettingsForSubject', () => {
  it('merges rather than replaces, so a later environment change still reaches the user', () => {
    writeSettingsForSubject('user-a', { uiZoom: 2 })
    writeSettingsForSubject('user-a', { studioSound: false })
    const s = readSettingsForSubject('user-a')
    expect(s.uiZoom).toBe(2)
    expect(s.studioSound).toBe(false)
  })

  it('never writes an overlay with no subject', () => {
    writeSettingsForSubject('', { uiZoom: 3 })
    expect(existsSync(join(dir, 'user-settings'))).toBe(false)
  })

  it('names the file from a hash, so an IdP subject with slashes is still safe on disk', () => {
    writeSettingsForSubject('https://idp.example/realms/x|user:1', { uiZoom: 4 })
    const files = readdirSync(join(dir, 'user-settings'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[0-9a-f]{32}\.json$/)
  })
})
