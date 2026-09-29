// @vitest-environment jsdom
/**
 * `ElectronStudioHost.CAPABILITIES` is exactly the native set plus the
 * bridged set, with nothing in both.
 *
 * The native set is pinned by name. Spec 12's end state is a desktop that
 * behaves like a browser client except where it genuinely needs an operating
 * system, so this list only ever shrinks: a capability leaves it when the
 * verb it gates gains a `studio_action` route and moves to
 * `BRIDGED_CAPABILITIES` (which both hosts report). Growing it -- routing a
 * new surface through Electron alone -- is the regression this test exists
 * to fail.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn() }))

import { BRIDGED_CAPABILITIES } from '../browser-shell-bridge'
import { CAPABILITIES, ElectronStudioHost, NATIVE_CAPABILITIES } from '../ElectronStudioHost'

/**
 * The Electron-only set as of this commit. Every entry names a reason it is
 * not (yet) on the wire; each Phase 1 commit of the shell-extraction plan
 * deletes a group and shrinks this snapshot with it.
 */
const PINNED_NATIVE = [
  // Electron shell verbs (dialogs, OS integration).
  'openExternal', 'pickFile', 'pickDirectory', 'clipboardWriteImage',
  // Host-environment feature domains a browser tab lacks.
  'browser', 'deeplink', 'tray', 'notifications', 'local', 'relay',
  // Aspirational wire-routed names that gate nothing today (StudioHost.ts).
  'terminal', 'git', 'files', 'questions', 'graph',
  // Electron-only verbs with no wire equivalent yet.
  'updates',
  'webApplicationOpen', 'startupReport',
  'windowShown', 'nativeWindowChrome',
  'nativeShell',
].sort()

describe('ElectronStudioHost capabilities', () => {
  it('is exactly the native set plus the bridged set', () => {
    const expected = new Set([...NATIVE_CAPABILITIES, ...BRIDGED_CAPABILITIES])
    expect(new Set(CAPABILITIES)).toEqual(expected)
    expect(CAPABILITIES.length).toBe(expected.size)
  })

  it('native and bridged sets do not overlap', () => {
    const overlap = NATIVE_CAPABILITIES.filter((c) => BRIDGED_CAPABILITIES.includes(c))
    expect(overlap).toEqual([])
  })

  it('pins the native set by name (shrink only)', () => {
    expect([...NATIVE_CAPABILITIES].sort()).toEqual(PINNED_NATIVE)
  })

  it('capabilities() reports the same set and hands out a copy', () => {
    const host = new ElectronStudioHost()
    const reported = host.capabilities()
    expect(new Set(reported)).toEqual(new Set(CAPABILITIES))
    reported.push('nativeShell')
    expect(host.capabilities().length).toBe(CAPABILITIES.length)
  })
})
