/**
 * Enterprise active-UI policy deriver (F4): malformed blobs → null,
 * ui validation, locked flag semantics.
 */
import { describe, it, expect } from 'vitest'
import { deriveEnterpriseActiveUiPolicy } from '../enterprise-active-ui-policy'
import type { EnterprisePolicy } from '../types-engine'

function blob(fields: unknown): EnterprisePolicy {
  return { customFields: { 'ion-desktop': fields } } as unknown as EnterprisePolicy
}

describe('deriveEnterpriseActiveUiPolicy', () => {
  it('valid blobs derive', () => {
    expect(deriveEnterpriseActiveUiPolicy(blob({ activeUiPolicy: { ui: 'studio', locked: true } }))).toEqual({ ui: 'studio', locked: true })
    expect(deriveEnterpriseActiveUiPolicy(blob({ activeUiPolicy: { ui: 'overlay' } }))).toEqual({ ui: 'overlay', locked: false })
  })

  it('malformed → null (never a throw, never a guess)', () => {
    expect(deriveEnterpriseActiveUiPolicy(null)).toBeNull()
    expect(deriveEnterpriseActiveUiPolicy(undefined)).toBeNull()
    expect(deriveEnterpriseActiveUiPolicy({} as EnterprisePolicy)).toBeNull()
    expect(deriveEnterpriseActiveUiPolicy(blob({}))).toBeNull()
    expect(deriveEnterpriseActiveUiPolicy(blob({ activeUiPolicy: 'studio' }))).toBeNull()
    expect(deriveEnterpriseActiveUiPolicy(blob({ activeUiPolicy: { ui: 'both', locked: true } }))).toBeNull()
    expect(deriveEnterpriseActiveUiPolicy(blob({ activeUiPolicy: { ui: 'atv' } }))).toBeNull()
    expect(deriveEnterpriseActiveUiPolicy(blob({ activeUiPolicy: { locked: true } }))).toBeNull()
  })

  it('locked is strictly boolean true', () => {
    expect(deriveEnterpriseActiveUiPolicy(blob({ activeUiPolicy: { ui: 'studio', locked: 'yes' } }))?.locked).toBe(false)
    expect(deriveEnterpriseActiveUiPolicy(blob({ activeUiPolicy: { ui: 'studio', locked: 1 } }))?.locked).toBe(false)
  })
})
