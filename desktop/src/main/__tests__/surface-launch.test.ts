import { describe, it, expect } from 'vitest'
import { resolveSurfacePlan, DEFAULT_ATV_SHORTCUT } from '../surface-launch'

describe('resolveSurfacePlan', () => {
  it('defaults: overlay launches, atv gated off (atvBeta not set)', () => {
    const plan = resolveSurfacePlan({})
    expect(plan).toEqual({
      showOverlayOnLaunch: true,
      openAtvOnLaunch: false,
      atvEnabled: false,
      overlayEnabled: true,
      atvShortcut: '', // no shortcut when atvEnabled is false
    })
  })

  it('launchSurface matrix under the permissive policy', () => {
    expect(resolveSurfacePlan({ atvBeta: true, launchSurface: 'atv' })).toMatchObject({
      showOverlayOnLaunch: false,
      openAtvOnLaunch: true,
    })
    expect(resolveSurfacePlan({ atvBeta: true, launchSurface: 'both' })).toMatchObject({
      showOverlayOnLaunch: true,
      openAtvOnLaunch: true,
    })
    expect(resolveSurfacePlan({ atvBeta: true, launchSurface: 'overlay' })).toMatchObject({
      showOverlayOnLaunch: true,
      openAtvOnLaunch: false,
    })
  })

  it('overlay-only policy disables the atv surface and clamps the preference', () => {
    const plan = resolveSurfacePlan({ surfacePolicy: 'overlay-only', launchSurface: 'atv' })
    expect(plan.atvEnabled).toBe(false)
    expect(plan.openAtvOnLaunch).toBe(false)
    expect(plan.showOverlayOnLaunch).toBe(true)
    expect(plan.atvShortcut).toBe('') // no shortcut for a disabled surface
  })

  it('atv-only policy hides the overlay glass and clamps the preference', () => {
    const plan = resolveSurfacePlan({ atvBeta: true, surfacePolicy: 'atv-only', launchSurface: 'overlay' })
    expect(plan.overlayEnabled).toBe(false)
    expect(plan.showOverlayOnLaunch).toBe(false)
    expect(plan.openAtvOnLaunch).toBe(true)
  })

  it('unknown values fall back to defaults', () => {
    const plan = resolveSurfacePlan({ launchSurface: 'x', surfacePolicy: 'y', atvShortcut: 42 })
    expect(plan.showOverlayOnLaunch).toBe(true)
    // atvBeta absent → atvEnabled false → no shortcut registered
    expect(plan.atvShortcut).toBe('')
  })

  it('persisted open state reopens the atv regardless of launchSurface (requires atvBeta)', () => {
    // atvBeta must also be true for the open-state restore to take effect.
    expect(resolveSurfacePlan({ atvBeta: true, atvWindowOpen: true })).toMatchObject({
      showOverlayOnLaunch: true,
      openAtvOnLaunch: true,
    })
    expect(resolveSurfacePlan({ atvBeta: true, launchSurface: 'overlay', atvWindowOpen: true }).openAtvOnLaunch).toBe(true)
    expect(resolveSurfacePlan({ atvBeta: true, atvWindowOpen: false }).openAtvOnLaunch).toBe(false)
    // Truthy junk never counts as open (settings.json is user-editable).
    expect(resolveSurfacePlan({ atvBeta: true, atvWindowOpen: 'yes' }).openAtvOnLaunch).toBe(false)
    // atvBeta absent: persisted open state is irrelevant, atv stays closed.
    expect(resolveSurfacePlan({ atvWindowOpen: true }).openAtvOnLaunch).toBe(false)
  })

  it('policy disabled between restarts wins over the persisted open state', () => {
    const plan = resolveSurfacePlan({ surfacePolicy: 'overlay-only', atvWindowOpen: true })
    expect(plan.openAtvOnLaunch).toBe(false)
    expect(plan.atvEnabled).toBe(false)
  })

  it('atvShortcut: custom accelerators accepted when atvBeta enabled; disabled without it', () => {
    expect(resolveSurfacePlan({ atvBeta: true, atvShortcut: 'CommandOrControl+Shift+V' }).atvShortcut).toBe('CommandOrControl+Shift+V')
    expect(resolveSurfacePlan({ atvBeta: true, atvShortcut: '' }).atvShortcut).toBe('')
    expect(resolveSurfacePlan({ atvBeta: true, atvShortcut: 'rm -rf /' }).atvShortcut).toBe('')
    // atvBeta false/absent: shortcut always empty regardless of atvShortcut value.
    expect(resolveSurfacePlan({ atvShortcut: 'CommandOrControl+Shift+V' }).atvShortcut).toBe('')
  })

  it('atvBeta: true enables atv with the default shortcut', () => {
    const plan = resolveSurfacePlan({ atvBeta: true })
    expect(plan.atvEnabled).toBe(true)
    expect(plan.atvShortcut).toBe(DEFAULT_ATV_SHORTCUT)
  })

  it('atvBeta: false keeps atv disabled even with permissive policy', () => {
    const plan = resolveSurfacePlan({ atvBeta: false })
    expect(plan.atvEnabled).toBe(false)
    expect(plan.atvShortcut).toBe('')
  })
})
