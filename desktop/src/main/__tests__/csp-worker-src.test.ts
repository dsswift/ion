/**
 * Pins the `worker-src 'self' blob:` CSP directive (child 05, GH #397):
 * `graphology-layout-forceatlas2`'s supervisor builds its layout worker
 * from a `blob:` URL, and the production CSP has no `worker-src` at all,
 * which falls back to `default-src 'self'` and refuses it.
 */
import { describe, expect, it } from 'vitest'
import { getContentSecurityPolicy } from '../window-manager'

describe('Content-Security-Policy worker-src', () => {
  it('production policy carries worker-src and an unchanged default-src', () => {
    delete process.env.ELECTRON_RENDERER_URL
    const csp = getContentSecurityPolicy()
    expect(csp).toContain("worker-src 'self' blob:")
    expect(csp).toContain("default-src 'self'")
  })

  it('dev policy carries worker-src and an unchanged default-src', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    const csp = getContentSecurityPolicy()
    expect(csp).toContain("worker-src 'self' blob:")
    expect(csp).toContain("default-src 'self'")
    delete process.env.ELECTRON_RENDERER_URL
  })
})
