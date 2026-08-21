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

describe('resolveSurfacePlan (single-UI exclusivity)', () => {
  it('defaults: overlay is the active UI; studio affordances absent', () => {
    const plan = resolveSurfacePlan({})
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
      const plan = resolveSurfacePlan(settings)
      expect(plan.studioEnabled !== plan.overlayEnabled).toBe(true)
    }
  })

  it('activeUi studio launches Studio and removes overlay affordances', () => {
    const plan = resolveSurfacePlan({ activeUi: 'studio' })
    expect(plan.activeUi).toBe('studio')
    expect(plan.openStudioOnLaunch).toBe(true)
    expect(plan.showOverlayOnLaunch).toBe(false)
    expect(plan.overlayEnabled).toBe(false)
    expect(plan.studioShortcut).toBe(DEFAULT_STUDIO_SHORTCUT)
  })

  it('legacy keys still resolve (managed settings pushed mid-cycle)', () => {
    expect(resolveSurfacePlan({ launchSurface: 'atv' }).activeUi).toBe('studio')
    expect(resolveSurfacePlan({ launchSurface: 'both' }).activeUi).toBe('overlay') // D1: no both
    expect(resolveSurfacePlan({ surfacePolicy: 'atv-only' }).activeUi).toBe('studio')
    expect(resolveSurfacePlan({ surfacePolicy: 'overlay-only' }).activeUi).toBe('overlay')
    // activeUi wins over legacy keys when both exist.
    expect(resolveSurfacePlan({ activeUi: 'overlay', launchSurface: 'atv' }).activeUi).toBe('overlay')
  })

  it('F2 regression: activeUi studio with NO other flags launches Studio (gate retired)', () => {
    const plan = resolveSurfacePlan({ activeUi: 'studio' })
    expect(plan.activeUi).toBe('studio')
    expect(plan.openStudioOnLaunch).toBe(true)
    // The retired gate key is inert if it lingers on disk.
    expect(resolveSurfacePlan({ activeUi: 'studio', studioBeta: false }).activeUi).toBe('studio')
  })

  it('locked policy clamps the user preference both ways', () => {
    const toStudio = resolveSurfacePlan({ activeUi: 'overlay' }, policyBlob('studio', true))
    expect(toStudio.activeUi).toBe('studio')
    expect(toStudio.lockedBy).toBe('policy')

    const toOverlay = resolveSurfacePlan({ activeUi: 'studio' }, policyBlob('overlay', true))
    expect(toOverlay.activeUi).toBe('overlay')
    expect(toOverlay.lockedBy).toBe('policy')
  })

  it('unlocked policy is a managed default: user preference wins', () => {
    expect(resolveSurfacePlan({}, policyBlob('studio', false)).activeUi).toBe('studio')
    expect(resolveSurfacePlan({ activeUi: 'overlay' }, policyBlob('studio', false)).activeUi).toBe('overlay')
  })

  it('malformed policy blob → null → settings fallback', () => {
    const junk = { customFields: { 'ion-desktop': { activeUiPolicy: { ui: 'both', locked: true } } } } as unknown as EnterprisePolicy
    expect(resolveSurfacePlan({ activeUi: 'studio' }, junk).activeUi).toBe('studio')
    expect(resolveSurfacePlan({}, null).activeUi).toBe('overlay')
  })

  it('studioShortcut: accelerator validation; absent in overlay mode', () => {
    expect(resolveSurfacePlan({ activeUi: 'studio', studioShortcut: 'CommandOrControl+Shift+V' }).studioShortcut).toBe('CommandOrControl+Shift+V')
    expect(resolveSurfacePlan({ activeUi: 'studio', studioShortcut: 'rm -rf /' }).studioShortcut).toBe('')
    expect(resolveSurfacePlan({ activeUi: 'overlay', studioShortcut: 'CommandOrControl+Shift+V' }).studioShortcut).toBe('')
  })
})
