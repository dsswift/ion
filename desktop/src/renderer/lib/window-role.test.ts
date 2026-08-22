/**
 * Pins the window-role detector to the studio.html entry file.
 *
 * This is the guard against the dual-persistence hazard: sessionStore gates
 * tabs.json persistence on isMirrorWindow(), so if the Studio entry file is
 * ever renamed without flipping this detector in the same commit, the Studio
 * window boots as a second OWNER and both windows write tabs.json.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { windowRole, isMirrorWindow } from './window-role'

const realWindow = globalThis.window

function stubPathname(pathname: string): void {
  Object.defineProperty(globalThis, 'window', {
    value: { location: { pathname } },
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    value: realWindow,
    configurable: true,
    writable: true,
  })
})

describe('windowRole', () => {
  it('studio.html → studio (the session-store MIRROR)', () => {
    stubPathname('/studio.html')
    expect(windowRole()).toBe('studio')
    expect(isMirrorWindow()).toBe(true)
  })

  it('dev-server URL variant of studio.html is still the mirror', () => {
    stubPathname('/some/base/studio.html')
    expect(windowRole()).toBe('studio')
    expect(isMirrorWindow()).toBe(true)
  })

  it('index.html → overlay (the session-store OWNER)', () => {
    stubPathname('/index.html')
    expect(windowRole()).toBe('overlay')
    expect(isMirrorWindow()).toBe(false)
  })

  it('the retired atv.html name no longer classifies as the mirror', () => {
    // A stale entry name must fall through to owner, not silently mirror:
    // nothing loads atv.html anymore, and the detector saying 'studio' for
    // it would mask an incomplete rename.
    stubPathname('/atv.html')
    expect(windowRole()).toBe('overlay')
    expect(isMirrorWindow()).toBe(false)
  })

  it('no window (main-process import) → overlay, never throws', () => {
    Object.defineProperty(globalThis, 'window', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    expect(windowRole()).toBe('overlay')
    expect(isMirrorWindow()).toBe(false)
  })
})
