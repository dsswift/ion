/**
 * Pins the window role to the explicit mirror declaration.
 *
 * Owner-only reducer side effects (the auto-fix close, for one) gate on
 * isMirrorWindow(). Studio runs the same reducers, so a Studio client that
 * reported itself as the owner would repeat the server's owner-only work.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
})

async function load(): Promise<typeof import('./window-role')> {
  return import('./window-role')
}

describe('windowRole', () => {
  it('is the owner until the mirror boot declares otherwise', async () => {
    const { windowRole, isMirrorWindow } = await load()
    expect(windowRole()).toBe('server')
    expect(isMirrorWindow()).toBe(false)
  })

  it('is a mirror after declareMirrorWindow, whatever entry file loaded the bundle', async () => {
    // The browser build serves Studio as index.html. A detector keyed on the
    // entry file name classified that client as the owner.
    vi.stubGlobal('window', { location: { pathname: '/index.html' } })
    const { windowRole, isMirrorWindow, declareMirrorWindow } = await load()
    declareMirrorWindow()
    expect(windowRole()).toBe('studio')
    expect(isMirrorWindow()).toBe(true)
    vi.unstubAllGlobals()
  })
})
