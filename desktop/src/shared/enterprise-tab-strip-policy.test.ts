import { describe, it, expect } from 'vitest'
import { deriveEnterpriseTabStripPolicy } from './enterprise-tab-strip-policy'
import type { EnterprisePolicy } from './types-engine'

const policy = (fields: unknown): EnterprisePolicy =>
  ({ customFields: { 'ion-desktop': fields } }) as unknown as EnterprisePolicy

describe('deriveEnterpriseTabStripPolicy', () => {
  // The dci deployment shape: hidden by default, user may turn it back on.
  it('reads a managed default', () => {
    expect(deriveEnterpriseTabStripPolicy(policy({ tabStripPolicy: { visible: false } })))
      .toEqual({ visible: false, locked: false })
  })

  it('reads an enforced policy', () => {
    expect(deriveEnterpriseTabStripPolicy(policy({ tabStripPolicy: { visible: false, locked: true } })))
      .toEqual({ visible: false, locked: true })
  })

  it('reads a policy that mandates the strip stays visible', () => {
    expect(deriveEnterpriseTabStripPolicy(policy({ tabStripPolicy: { visible: true, locked: true } })))
      .toEqual({ visible: true, locked: true })
  })

  // `visible` is the whole content of the policy. A block without it expresses
  // nothing, and defaulting it either way would invent an opinion the operator
  // never wrote -- in one direction hiding a strip nobody asked to hide.
  it('rejects a block with no visible key', () => {
    expect(deriveEnterpriseTabStripPolicy(policy({ tabStripPolicy: { locked: true } }))).toBeNull()
  })

  it('rejects a non-boolean visible', () => {
    expect(deriveEnterpriseTabStripPolicy(policy({ tabStripPolicy: { visible: 'false' } }))).toBeNull()
  })

  it.each([
    ['no policy at all', null],
    ['an unmanaged install', policy({})],
    ['a non-object block', policy({ tabStripPolicy: 'hidden' })],
  ])('returns null for %s', (_label, input) => {
    expect(deriveEnterpriseTabStripPolicy(input as EnterprisePolicy | null)).toBeNull()
  })

  // locked is opt-in: anything other than exactly true leaves the user in
  // control, so a typo cannot silently seal a setting.
  it.each([[undefined], [false], ['true'], [1]])('treats locked=%s as unlocked', (locked) => {
    expect(deriveEnterpriseTabStripPolicy(policy({ tabStripPolicy: { visible: false, locked } }))?.locked)
      .toBe(false)
  })
})
