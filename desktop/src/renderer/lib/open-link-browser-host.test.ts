// @vitest-environment jsdom
/**
 * Regression test (spec 18): `openClickedLink` used to call
 * `host.shell.openExternal`, which is Electron-only — on a `BrowserStudioHost`
 * (no `window.ion`, per `host-instance.ts`'s discriminator) that throws
 * synchronously and crashes the click handler. The fix routes through
 * `host.openExternal`, the top-level `StudioHost` method both hosts actually
 * implement (`BrowserStudioHost`'s opens a real `window.open` tab).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openClickedLink } from './open-link'

vi.mock('../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn(), rInfo: vi.fn(), rTrace: vi.fn(), rError: vi.fn() }))

const originalOpen = window.open

beforeEach(() => {
  // No `window.ion` — this is the one discriminator `host-instance.ts` uses
  // to resolve `BrowserStudioHost` instead of `ElectronStudioHost`.
  delete (window as unknown as { ion?: unknown }).ion
  window.open = vi.fn(() => ({}) as Window)
})

afterEach(() => {
  window.open = originalOpen
})

describe('openClickedLink on a browser Studio client', () => {
  it('does not throw and opens the link via window.open', () => {
    expect(() => openClickedLink('https://example.test/docs', {})).not.toThrow()
    expect(window.open).toHaveBeenCalledWith('https://example.test/docs', '_blank', 'noopener,noreferrer')
  })
})
