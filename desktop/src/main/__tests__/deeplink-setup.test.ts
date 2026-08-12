/**
 * Tests for `ion://` scheme setup.
 *
 * `extractIonUrl` is the shared parser for both argv-delivery paths, and it is
 * the one piece of scheme wiring that is pure enough to test directly. It
 * matters because argv is noisy: it carries the exec path, Electron's own flags,
 * and (in dev) the project path, so picking the URL out by prefix rather than by
 * position is what makes cold launch and `second-instance` work on every
 * platform.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

// Imported for its side-effect-free helper only; the module's other exports
// touch app/window singletons that belong to integration, not unit, coverage.
vi.mock('../window-manager', () => ({ showWindow: vi.fn() }))
vi.mock('../deeplink/dispatch', () => ({
  handleDeepLink: vi.fn(), configureDeepLinks: vi.fn(),
}))
vi.mock('../deeplink/handoff', () => ({ ensureHandoffDir: vi.fn() }))
vi.mock('../deeplink/token', () => ({ getDeepLinkToken: vi.fn(() => 'tok') }))

import { extractIonUrl, ION_SCHEME } from '../deeplink-setup'

describe('extractIonUrl', () => {
  it('finds the url in a packaged-app argv', () => {
    const argv = ['/Applications/Ion.app/Contents/MacOS/Ion', 'ion://terminal?tabId=tab-a']

    expect(extractIonUrl(argv)).toBe('ion://terminal?tabId=tab-a')
  })

  it('finds the url in a dev argv, past the electron binary and project path', () => {
    const argv = [
      '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      '/repo/desktop',
      'ion://prompt?dir=/repo&text=hi',
    ]

    expect(extractIonUrl(argv)).toBe('ion://prompt?dir=/repo&text=hi')
  })

  it('ignores electron flags that precede the url', () => {
    const argv = ['/path/Ion', '--enable-logging', '--no-sandbox', 'ion://terminal?tabId=x']

    expect(extractIonUrl(argv)).toBe('ion://terminal?tabId=x')
  })

  it('returns null for a plain launch with no url', () => {
    expect(extractIonUrl(['/Applications/Ion.app/Contents/MacOS/Ion'])).toBeNull()
  })

  it('returns null for an empty argv', () => {
    expect(extractIonUrl([])).toBeNull()
  })

  it('does not match a different scheme that merely contains "ion"', () => {
    // "notion://" contains "ion" but is not our scheme; matching on a bare
    // substring would hijack another app's links.
    expect(extractIonUrl(['/path/Ion', 'notion://page/123'])).toBeNull()
    expect(extractIonUrl(['/path/Ion', 'https://example.com/ion://x'])).toBeNull()
  })

  it('takes the first url when several are present', () => {
    const argv = ['/path/Ion', 'ion://terminal?tabId=first', 'ion://terminal?tabId=second']

    expect(extractIonUrl(argv)).toBe('ion://terminal?tabId=first')
  })

  it('exposes the scheme name it matches on', () => {
    expect(ION_SCHEME).toBe('ion')
  })
})
