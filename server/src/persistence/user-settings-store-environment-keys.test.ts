/**
 * A per-identity overlay never shadows an environment-owned key: an overlay
 * written before the ownership split can carry a stale `streamThinkingToRemote`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const paths = vi.hoisted(() => ({ dir: '' }))
vi.mock('./settings-store', () => ({ readSettings: () => ({ streamThinkingToRemote: true, selectedTheme: 'env-default' }) }))
vi.mock('../paths', () => ({ dataDir: () => paths.dir }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { readSettingsForSubject, writeSettingsForSubject } from './user-settings-store'

beforeEach(() => { paths.dir = mkdtempSync(join(tmpdir(), 'ion-overlay-')) })

describe('user settings overlay and environment-owned keys', () => {
  it('a stale environment key in an old overlay does not shadow settings.json', () => {
    // Write through the store first so the overlay exists at the real path,
    // then stamp a stale environment key into it the way an old client did.
    writeSettingsForSubject('local:josh', { selectedTheme: 'mine' })
    const dir = join(paths.dir, 'user-settings')
    const file = readdirSync(dir).find((f) => f.endsWith('.json'))!
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as { subject: string; settings: Record<string, unknown> }
    doc.settings.streamThinkingToRemote = false
    writeFileSync(join(dir, file), JSON.stringify(doc))
    expect(readSettingsForSubject('local:josh')).toEqual({ streamThinkingToRemote: true, selectedTheme: 'mine' })
  })

  it('a write drops environment-owned keys before they reach the overlay', () => {
    writeSettingsForSubject('local:josh', { streamThinkingToRemote: false, relayUrl: 'x', selectedTheme: 'mine' })
    expect(readSettingsForSubject('local:josh')).toEqual({ streamThinkingToRemote: true, selectedTheme: 'mine' })
  })
})
