/**
 * resolveSurfacePlan — single-UI exclusivity matrix (D1):
 * activeUi × legacy keys × enterprise policy × studioBeta.
 */
import { describe, it, expect } from 'vitest'
import { resolveSurfacePlan, DEFAULT_STUDIO_SHORTCUT } from '../surface-launch'
import type { EnterprisePolicy } from '../../shared/types-engine'

function policyBlob(ui: string, locked: boolean): EnterprisePolicy {
  return { customFields: { 'ion-desktop': { activeUiPolicy: { ui, locked } } } } as unknown as EnterprisePolicy
}

// resolveSurfacePlan's third argument defaults to process.platform, which is
// 'win32' on Windows CI -- win32 unconditionally clamps to Studio (see
// surface-launch.ts's own doc comment: "the Overlay glass is a non-goal
// [there]... Studio is the only conversation interface"), so every test
// below that exercises the general (non-platform) resolution matrix must
// pin a non-win32 platform explicitly rather than inherit whichever OS
// happens to run the suite. The dedicated win32/darwin tests at the bottom
// of this file call resolveSurfacePlan directly with an explicit platform.
function resolve(settings: Record<string, unknown>, policy?: EnterprisePolicy | null) {
  return resolveSurfacePlan(settings, policy, 'darwin')
}

describe('resolveSurfacePlan (single-UI exclusivity)', () => {
  it('defaults: overlay is the active UI; studio affordances absent', () => {
    const plan = resolve({})
    expect(plan).toEqual({
      activeUi: 'overlay',
      showOverlayOnLaunch: true,
      openStudioOnLaunch: false,
      studioEnabled: false,
      overlayEnabled: true,
      studioShortcut: '',
      lockedBy: null,
    })
  })

  it('exactly ONE UI is ever enabled — never both, never neither', () => {
    for (const settings of [
      {},
      { activeUi: 'studio' },
      { activeUi: 'overlay' },
      { launchSurface: 'both' },
    ]) {
      const plan = resolve(settings)
      expect(plan.studioEnabled !== plan.overlayEnabled).toBe(true)
    }
  })

  it('activeUi studio launches Studio and removes overlay affordances', () => {
    const plan = resolve({ activeUi: 'studio' })
    expect(plan.activeUi).toBe('studio')
    expect(plan.openStudioOnLaunch).toBe(true)
    expect(plan.showOverlayOnLaunch).toBe(false)
    expect(plan.overlayEnabled).toBe(false)
    expect(plan.studioShortcut).toBe(DEFAULT_STUDIO_SHORTCUT)
  })

  it('legacy keys still resolve (managed settings pushed mid-cycle)', () => {
    expect(resolve({ launchSurface: 'atv' }).activeUi).toBe('studio')
    expect(resolve({ launchSurface: 'both' }).activeUi).toBe('overlay') // D1: no both
    expect(resolve({ surfacePolicy: 'atv-only' }).activeUi).toBe('studio')
    expect(resolve({ surfacePolicy: 'overlay-only' }).activeUi).toBe('overlay')
    // activeUi wins over legacy keys when both exist.
    expect(resolve({ activeUi: 'overlay', launchSurface: 'atv' }).activeUi).toBe('overlay')
  })

  it('F2 regression: activeUi studio with NO other flags launches Studio (gate retired)', () => {
    const plan = resolve({ activeUi: 'studio' })
    expect(plan.activeUi).toBe('studio')
    expect(plan.openStudioOnLaunch).toBe(true)
    // The retired gate key is inert if it lingers on disk.
    expect(resolve({ activeUi: 'studio', studioBeta: false }).activeUi).toBe('studio')
  })

  it('locked policy clamps the user preference both ways', () => {
    const toStudio = resolve({ activeUi: 'overlay' }, policyBlob('studio', true))
    expect(toStudio.activeUi).toBe('studio')
    expect(toStudio.lockedBy).toBe('policy')

    const toOverlay = resolve({ activeUi: 'studio' }, policyBlob('overlay', true))
    expect(toOverlay.activeUi).toBe('overlay')
    expect(toOverlay.lockedBy).toBe('policy')
  })

  it('unlocked policy is a managed default: user preference wins', () => {
    expect(resolve({}, policyBlob('studio', false)).activeUi).toBe('studio')
    expect(resolve({ activeUi: 'overlay' }, policyBlob('studio', false)).activeUi).toBe('overlay')
  })

  it('malformed policy blob → null → settings fallback', () => {
    const junk = { customFields: { 'ion-desktop': { activeUiPolicy: { ui: 'both', locked: true } } } } as unknown as EnterprisePolicy
    expect(resolve({ activeUi: 'studio' }, junk).activeUi).toBe('studio')
    expect(resolve({}, null).activeUi).toBe('overlay')
  })

  it('studioShortcut: accelerator validation; absent in overlay mode', () => {
    expect(resolve({ activeUi: 'studio', studioShortcut: 'CommandOrControl+Shift+V' }).studioShortcut).toBe('CommandOrControl+Shift+V')
    expect(resolve({ activeUi: 'studio', studioShortcut: 'rm -rf /' }).studioShortcut).toBe('')
    expect(resolve({ activeUi: 'overlay', studioShortcut: 'CommandOrControl+Shift+V' }).studioShortcut).toBe('')
  })

  it('win32 with activeUi overlay → studio, lockedBy platform, overlayEnabled false', () => {
    const plan = resolveSurfacePlan({ activeUi: 'overlay' }, null, 'win32')
    expect(plan.activeUi).toBe('studio')
    expect(plan.lockedBy).toBe('platform')
    expect(plan.overlayEnabled).toBe(false)
    expect(plan.studioEnabled).toBe(true)
    expect(plan.showOverlayOnLaunch).toBe(false)
    expect(plan.openStudioOnLaunch).toBe(true)
  })

  it('win32 with locked policy overlay → still studio, lockedBy platform (platform outranks policy)', () => {
    const plan = resolveSurfacePlan({ activeUi: 'studio' }, policyBlob('overlay', true), 'win32')
    expect(plan.activeUi).toBe('studio')
    expect(plan.lockedBy).toBe('platform')
  })

  it('darwin unchanged: the default platform parameter preserves every existing assertion above', () => {
    const plan = resolveSurfacePlan({ activeUi: 'overlay' }, null, 'darwin')
    expect(plan.activeUi).toBe('overlay')
    expect(plan.lockedBy).toBe(null)
  })
})
