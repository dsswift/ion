/**
 * deriveDesktopEnvironmentPolicy — the typed { mode, allowed, locked } view
 * of customFields['ion-desktop'].environmentPolicy the desktop catalog
 * enforces against (spec 14, manifest C11).
 */
import { describe, expect, it } from 'vitest'
import { deriveDesktopEnvironmentPolicy } from '../enterprise-environment-policy'
import type { EnterprisePolicy } from '../types-engine'

function policy(environmentPolicy: unknown): EnterprisePolicy {
  return { customFields: { 'ion-desktop': { environmentPolicy } } }
}

describe('deriveDesktopEnvironmentPolicy', () => {
  it('defaults to allowlist, empty, unlocked when the field is absent', () => {
    expect(deriveDesktopEnvironmentPolicy(null)).toEqual({ mode: 'allowlist', allowed: [], locked: false })
    expect(deriveDesktopEnvironmentPolicy(undefined)).toEqual({ mode: 'allowlist', allowed: [], locked: false })
    expect(deriveDesktopEnvironmentPolicy({})).toEqual({ mode: 'allowlist', allowed: [], locked: false })
  })

  it('reads a well-formed local-only policy', () => {
    const result = deriveDesktopEnvironmentPolicy(policy({ mode: 'local-only', locked: true }))
    expect(result).toEqual({ mode: 'local-only', allowed: [], locked: true })
  })

  it('reads a well-formed allowlist policy with allowed entries', () => {
    const result = deriveDesktopEnvironmentPolicy(policy({ mode: 'allowlist', allowed: ['wss://a', 'wss://b'], locked: true }))
    expect(result).toEqual({ mode: 'allowlist', allowed: ['wss://a', 'wss://b'], locked: true })
  })

  it('reads a well-formed central-only policy', () => {
    const result = deriveDesktopEnvironmentPolicy(policy({ mode: 'central-only' }))
    expect(result).toEqual({ mode: 'central-only', allowed: [], locked: false })
  })

  it('an unlocked allowlist is a managed default, not enforcement', () => {
    const result = deriveDesktopEnvironmentPolicy(policy({ mode: 'allowlist', allowed: ['wss://a'], locked: false }))
    expect(result.locked).toBe(false)
  })

  it('falls back to allowlist for a malformed mode', () => {
    const result = deriveDesktopEnvironmentPolicy(policy({ mode: 'not-a-real-mode' }))
    expect(result.mode).toBe('allowlist')
  })

  it('drops non-string entries from allowed', () => {
    const result = deriveDesktopEnvironmentPolicy(policy({ mode: 'allowlist', allowed: ['ok', 123, null, 'also-ok'] }))
    expect(result.allowed).toEqual(['ok', 'also-ok'])
  })

})
