/**
 * Pins that a PERSONAL preference resolves from the caller's overlay, not from
 * the Environment document.
 *
 * Context — the bug this file exists to prevent from returning. Changing
 * "Default thinking level" in Settings wrote `defaultThinkingEffort` into the
 * caller's overlay (correct: the key is not environment-owned, so
 * `settings.save` partitions it there) and `settings.load` read it back, so
 * the dialog displayed the new level. But every server-side consumer of the
 * same preference called `readSettings()`, which sees ONLY the Environment
 * document. An operator whose `settings.json` still carried a long-since
 * replaced `"high"` therefore watched each new conversation open on High while
 * Settings insisted it was Medium.
 *
 * Revert proof: resolving through `readSettings()` instead of
 * `readSettingsForSubject()` makes every overlay case below return the
 * Environment value and fail.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SessionPrincipal } from '@ion/shared/types-engine'

let dir: string
vi.mock('../paths', () => ({ dataDir: () => dir }))

const LOCAL: SessionPrincipal = { subject: 'local:test-operator', provider: 'os', kind: 'local', displayName: 'test-operator' }
vi.mock('../identity/local-principal', () => ({ localPrincipal: () => LOCAL }))

import { runAsPrincipal } from '../identity/request-principal'
import { writeSettingsForSubject, readSettingsForSubject } from './user-settings-store'
import {
  effectiveSubject,
  readEffectiveSettings,
  writeEffectiveSettings,
} from './effective-settings'

/** A principal shaped like an authenticated wire client's. */
function remote(subject: string) {
  return { principal: { subject, provider: 'oidc', kind: 'user', displayName: subject } as unknown as never }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-effective-settings-'))
  // The Environment document, carrying the level the operator has replaced.
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ defaultThinkingEffort: 'high', uiZoom: 1 }))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('effectiveSubject', () => {
  it('falls back to the local operator outside any request chain', () => {
    expect(effectiveSubject()).toBe('local:test-operator')
  })

  it('uses the ambient request principal when there is one', () => {
    runAsPrincipal(remote('oidc|bob') as never, () => {
      expect(effectiveSubject()).toBe('oidc|bob')
    })
  })

  it('prefers an explicit subject over the ambient one', () => {
    runAsPrincipal(remote('oidc|bob') as never, () => {
      expect(effectiveSubject('oidc|carol')).toBe('oidc|carol')
    })
  })
})

describe('readEffectiveSettings', () => {
  it('returns the Environment document when the caller has no overlay', () => {
    expect(readEffectiveSettings()).toMatchObject({ defaultThinkingEffort: 'high', uiZoom: 1 })
  })

  it('applies the caller overlay over the Environment document', () => {
    writeSettingsForSubject('local:test-operator', { defaultThinkingEffort: 'medium' })
    const s = readEffectiveSettings()
    expect(s.defaultThinkingEffort).toBe('medium')
    // A key the caller never set still follows the Environment.
    expect(s.uiZoom).toBe(1)
  })
})

describe('writeEffectiveSettings', () => {
  it('writes to the overlay the reader reads, so a write is readable back', () => {
    // The asymmetry this pins: a setter persisting to the Environment document
    // while its getter prefers the overlay writes a value it can never read
    // back, because the stale overlay entry shadows it forever.
    writeSettingsForSubject('local:test-operator', { defaultThinkingEffort: 'high' })
    writeEffectiveSettings({ defaultThinkingEffort: 'low' })
    expect(readEffectiveSettings().defaultThinkingEffort).toBe('low')
  })

  it('leaves the Environment document untouched', () => {
    writeEffectiveSettings({ defaultThinkingEffort: 'low' })
    // Another identity, with no overlay of its own, still sees the Environment.
    expect(readSettingsForSubject('oidc|bob').defaultThinkingEffort).toBe('high')
  })

  it('never freezes an inherited Environment default into the overlay', () => {
    writeEffectiveSettings({ defaultThinkingEffort: 'low' })
    // uiZoom was never chosen by this caller, so it must not be captured —
    // otherwise a later Environment change would stop reaching this user.
    expect(Object.keys(readOverlaySettings())).toEqual(['defaultThinkingEffort'])
  })
})

/** The overlay's own keys, without the Environment document merged under it. */
function readOverlaySettings(): Record<string, unknown> {
  const merged = readSettingsForSubject('local:test-operator')
  const base = readSettingsForSubject('')
  return Object.fromEntries(Object.entries(merged).filter(([k, v]) => base[k] !== v))
}
