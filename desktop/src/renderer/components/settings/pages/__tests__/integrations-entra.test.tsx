// @vitest-environment jsdom
/**
 * EntraSection — one row that reads the signed-in identity on mount, signs
 * in and shows who, shows a refusal verbatim, and clears the identity on
 * sign-out even when the server call fails.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeWire } from '../../../../host/__tests__/fake-wire'
import { createHarness, type Harness } from './page-harness'

vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn() }))

const { EntraSection } = await import('../integrations/EntraSection')

const identity = { user: 'u1', username: 'user@example.com', displayName: 'Example User', oid: 'oid-1' }
const ion = {
  entraIdentity: vi.fn(),
  entraSignIn: vi.fn(),
  entraSignOut: vi.fn(),
}

let h: Harness
beforeEach(() => {
  vi.clearAllMocks()
  ion.entraIdentity.mockResolvedValue({ identity: null })
  ion.entraSignIn.mockResolvedValue({ ok: true, identity })
  ion.entraSignOut.mockResolvedValue(undefined)
  ;(window as unknown as { ion: unknown }).ion = installFakeWire(ion)
  h = createHarness()
})
afterEach(() => h.unmount())

const text = (): string => h.container.textContent ?? ''

describe('EntraSection', () => {
  it('signs in and shows who is signed in', async () => {
    await h.render(<EntraSection />)
    expect(text()).toContain('Microsoft Entra (OIDC)')
    await h.click('Sign in with Microsoft')
    expect(ion.entraSignIn).toHaveBeenCalled()
    expect(text()).toContain('Signed in as Example User (user@example.com)')
    expect(h.maybeControl('Sign out')).toBeDefined()
  })

  it('shows a refused sign-in and offers it again', async () => {
    ion.entraSignIn.mockResolvedValue({ ok: false, error: 'tenant not allowed' })
    await h.render(<EntraSection />)
    await h.click('Sign in with Microsoft')
    expect(text()).toContain('tenant not allowed')
    expect(h.maybeControl('Sign in with Microsoft')).toBeDefined()
  })

  it('clears the identity on sign-out even when the call fails', async () => {
    ion.entraIdentity.mockResolvedValue({ identity })
    ion.entraSignOut.mockRejectedValue(new Error('offline'))
    await h.render(<EntraSection />)
    expect(text()).toContain('Signed in as Example User')
    await h.click('Sign out')
    expect(text()).not.toContain('Signed in as')
    expect(h.maybeControl('Sign in with Microsoft')).toBeDefined()
  })
})
