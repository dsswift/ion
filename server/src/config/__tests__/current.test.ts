import { describe, expect, it, afterEach } from 'vitest'
import { _resetCurrentServerConfigForTest, currentServerConfig, isMultiTenant, isSharedTenancy, setCurrentServerConfig, unownedTabsVisible } from '../current'
import type { ServerOidcConfig } from '../server-config'

const oidc: ServerOidcConfig = {
  issuer: 'https://issuer.example.org',
  audience: 'ion-server',
  scope: 'api://ion-server/.default',
  clientId: 'browser-client',
  rolesToScopes: {},
  defaultScopes: [],
  allowedSubjects: [],
    clientSecret: '',
}

afterEach(() => {
  _resetCurrentServerConfigForTest()
})

describe('isMultiTenant', () => {
  it('is false by default (no oidc configured — local/paired trusted-owner mode)', () => {
    expect(isMultiTenant()).toBe(false)
  })

  it('is true once server.json.oidc is configured', () => {
    setCurrentServerConfig({ ...currentServerConfig(), oidc })
    expect(isMultiTenant()).toBe(true)
  })

  it('reverts to false once oidc is cleared', () => {
    setCurrentServerConfig({ ...currentServerConfig(), oidc })
    expect(isMultiTenant()).toBe(true)
    setCurrentServerConfig({ ...currentServerConfig(), oidc: null })
    expect(isMultiTenant()).toBe(false)
  })
})

describe('unownedTabsVisible', () => {
  it('defaults to true with no oidc configured', () => {
    expect(unownedTabsVisible()).toBe(true)
  })

  it('defaults to false once oidc is configured, tracked live with no explicit tenancy override', () => {
    setCurrentServerConfig({ ...currentServerConfig(), oidc })
    expect(unownedTabsVisible()).toBe(false)
    setCurrentServerConfig({ ...currentServerConfig(), oidc: null })
    expect(unownedTabsVisible()).toBe(true)
  })

  it('an explicit tenancy.unownedTabs override always wins, even against the oidc-derived default', () => {
    setCurrentServerConfig({ ...currentServerConfig(), oidc, tenancy: { unownedTabs: 'visible' } })
    expect(unownedTabsVisible()).toBe(true)

    setCurrentServerConfig({ ...currentServerConfig(), oidc: null, tenancy: { unownedTabs: 'hidden' } })
    expect(unownedTabsVisible()).toBe(false)
  })
})

describe('isSharedTenancy', () => {
  it('is false by default (isolated)', () => {
    expect(isSharedTenancy()).toBe(false)
  })

  it('is false when tenancy.mode is explicitly isolated', () => {
    setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'isolated' } })
    expect(isSharedTenancy()).toBe(false)
  })

  it('is true when tenancy.mode is shared', () => {
    setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'shared' } })
    expect(isSharedTenancy()).toBe(true)
  })

  it('has no derived default from oidc, unlike unownedTabsVisible', () => {
    setCurrentServerConfig({ ...currentServerConfig(), oidc })
    expect(isSharedTenancy()).toBe(false)
  })
})
