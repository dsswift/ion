// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerContentRouter, type ContentRouter } from './file-open-router'
import { isWebUrl, openClickedLink, wantsNativeBrowser, wantsSurfaceBrowser } from './open-link'

vi.mock('../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn(), rInfo: vi.fn(), rTrace: vi.fn(), rError: vi.fn() }))

const openExternal = vi.fn(async () => true)
const openUrl = vi.fn(() => true)
let unregister: (() => void) | null = null

function installRouter(overrides: Partial<ContentRouter> = {}): void {
  unregister = registerContentRouter({
    openTextFile: vi.fn(),
    openImage: vi.fn(),
    openHtml: vi.fn(),
    openGitDiff: vi.fn(() => true),
    openUrl,
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  openUrl.mockReturnValue(true)
  ;(window as unknown as { ion: unknown }).ion = { openExternal }
})

afterEach(() => {
  unregister?.()
  unregister = null
})

describe('gesture', () => {
  it('treats cmd and ctrl as the same request', () => {
    // ⌘ on a Mac keyboard, Ctrl on an external PC keyboard. Accepting both
    // means the operator does not have to know which convention Ion picked.
    expect(wantsSurfaceBrowser({ metaKey: true })).toBe(true)
    expect(wantsSurfaceBrowser({ ctrlKey: true })).toBe(true)
    expect(wantsSurfaceBrowser({})).toBe(false)
    expect(wantsSurfaceBrowser(null)).toBe(false)
  })

  it('treats the option key as the escape, not the inward route', () => {
    // ⌥ must CANCEL the surface route, not merely add a second meaning: if
    // both predicates were true the dispatcher order would decide, and the
    // escape would be one refactor away from silently disappearing.
    expect(wantsSurfaceBrowser({ metaKey: true, altKey: true })).toBe(false)
    expect(wantsNativeBrowser({ metaKey: true, altKey: true })).toBe(true)
    expect(wantsNativeBrowser({ ctrlKey: true, altKey: true })).toBe(true)
    // ⌥ alone is not the gesture; a bare alt-click stays an ordinary click.
    expect(wantsNativeBrowser({ altKey: true })).toBe(false)
    expect(wantsNativeBrowser({ metaKey: true })).toBe(false)
  })

  it('accepts only http and https as embeddable', () => {
    expect(isWebUrl('https://example.test/a')).toBe(true)
    expect(isWebUrl('http://localhost:3000')).toBe(true)
    // These have no meaning in a Chromium tab and belong to the OS handler.
    expect(isWebUrl('mailto:dev@example.com')).toBe(false)
    expect(isWebUrl('vscode://file/tmp/a.ts')).toBe(false)
    expect(isWebUrl('file:///tmp/a.html')).toBe(false)
    expect(isWebUrl('not a url')).toBe(false)
  })
})

describe('routing in Studio', () => {
  beforeEach(installRouter)

  it('sends a cmd-clicked web link to the surface browser', () => {
    openClickedLink('https://example.test/docs', { metaKey: true })
    expect(openUrl).toHaveBeenCalledWith('https://example.test/docs')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('leaves a plain click with the default browser', () => {
    openClickedLink('https://example.test/docs', {})
    // Making the embedded browser the default for every click would quietly
    // change where all of the operator's links land.
    expect(openUrl).not.toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith('https://example.test/docs')
  })

  it('escapes to the default browser on a cmd-option-click', () => {
    openClickedLink('https://example.test/docs', { metaKey: true, altKey: true })
    // The whole point of the escape: a real browser has the operator's
    // password manager, profile, and extensions.
    expect(openUrl).not.toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith('https://example.test/docs')
  })

  it('sends a non-web scheme to the OS even on a cmd-click', () => {
    openClickedLink('mailto:dev@example.com', { metaKey: true })
    expect(openUrl).not.toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith('mailto:dev@example.com')
  })

  it('falls back to the OS when the router declines the URL', () => {
    openUrl.mockReturnValue(false)
    openClickedLink('https://example.test/docs', { metaKey: true })
    // A declined route must still open somewhere; a dropped click would look
    // like a broken link.
    expect(openExternal).toHaveBeenCalledWith('https://example.test/docs')
  })

  it('ignores an empty href entirely', () => {
    openClickedLink('', { metaKey: true })
    expect(openUrl).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('routing without a Studio router', () => {
  it('uses the default browser for every click', () => {
    // The Overlay never registers a content router, so this is its behaviour
    // with no window-role branch anywhere in the shared components.
    openClickedLink('https://example.test/docs', { metaKey: true })
    expect(openExternal).toHaveBeenCalledWith('https://example.test/docs')
  })

  it('falls back when an older router has no openUrl', () => {
    installRouter({ openUrl: undefined })
    openClickedLink('https://example.test/docs', { metaKey: true })
    expect(openExternal).toHaveBeenCalledWith('https://example.test/docs')
  })
})
