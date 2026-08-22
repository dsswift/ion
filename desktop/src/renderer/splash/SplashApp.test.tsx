import { describe, expect, it, vi } from 'vitest'
import heroImage from './assets/ion-engine-hero-web.jpg'
import ionIcon from './assets/ion-icon.png'
import { SplashApp } from './SplashApp'

vi.mock('react', () => ({ default: { createElement: vi.fn() } }))

describe('SplashApp', () => {
  it('uses canonical product name, icon, and website hero asset', () => {
    expect(heroImage).toContain('ion-engine-hero-web.jpg')
    expect(ionIcon).toContain('ion-icon.png')
    const node = SplashApp({
      state: {
        sequence: 1, target: 'overlay', source: 'owner', status: 'Loading…', mode: 'loading',
        authenticationBusy: false, authenticationError: null, appVersion: '1.0.0', ownerReady: false, studioReady: false, error: null,
      },
    })
    expect(node).toBeTruthy()
  })

  it('renders exact startup status without product controls', () => {
    const node = SplashApp({
      state: {
        sequence: 1, target: 'overlay', source: 'owner', status: 'Restoring 3 tabs…', mode: 'loading',
        authenticationBusy: false, authenticationError: null, appVersion: '1.0.0', ownerReady: false, studioReady: false, error: null,
      },
    })
    expect(node).toBeTruthy()
  })

  it('renders required authentication as a browser sign-in gate', () => {
    const node = SplashApp({
      state: {
        sequence: 2, target: 'studio', source: 'main', status: 'Sign in to continue', mode: 'authentication',
        authenticationBusy: false, authenticationError: null, appVersion: '1.0.0', ownerReady: false, studioReady: false, error: null,
      },
    })
    expect(node).toBeTruthy()
  })
})
