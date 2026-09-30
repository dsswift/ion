import { describe, it, expect } from 'vitest'
import { resolveEffectiveThemeId } from '../enterprise-theme-policy'

const policy = (locked: boolean) => ({ customFields: { 'ion-desktop': { themePolicy: { themeId: 'acme-corp', locked } } } })

describe('resolveEffectiveThemeId', () => {
  it('returns the enforced id under a locked policy', () => {
    expect(resolveEffectiveThemeId(policy(true), 'ion-light')).toBe('acme-corp')
  })
  it('returns the user choice under an unlocked policy or none', () => {
    expect(resolveEffectiveThemeId(policy(false), 'ion-light')).toBe('ion-light')
    expect(resolveEffectiveThemeId(null, 'ion-light')).toBe('ion-light')
  })
})
