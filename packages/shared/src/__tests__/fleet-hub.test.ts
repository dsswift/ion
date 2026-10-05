import { describe, expect, it } from 'vitest'
import { deriveFleetHubsPolicy, fleetHubAllowed, hubAgentUrl, isHubAction, normalizeHubUrl } from '../fleet-hub'

const policy = (fleetHubs: unknown) => ({ customFields: { 'ion-server': { fleetHubs } } })

describe('normalizeHubUrl', () => {
  it('gives two spellings of one hub the same form', () => {
    expect(normalizeHubUrl('https://Hub.Example.org/')).toBe('https://hub.example.org')
    expect(normalizeHubUrl('wss://hub.example.org/v1/agent?x=1')).toBe('https://hub.example.org')
    expect(normalizeHubUrl('http://10.0.0.5:7400')).toBe('http://10.0.0.5:7400')
    // A bare host, as a person types it.
    expect(normalizeHubUrl('hub.example.org')).toBe('https://hub.example.org')
  })
  it('refuses what is not a web address', () => {
    expect(normalizeHubUrl('nonsense')).toBeNull()
    expect(normalizeHubUrl('ftp://hub.example.org')).toBeNull()
    expect(normalizeHubUrl('')).toBeNull()
    expect(normalizeHubUrl(7)).toBeNull()
  })
  it('names the socket a server dials', () => {
    expect(hubAgentUrl('https://hub.example.org')).toBe('wss://hub.example.org/v1/agent')
    expect(hubAgentUrl('http://10.0.0.5:7400')).toBe('ws://10.0.0.5:7400/v1/agent')
  })
})

describe('deriveFleetHubsPolicy', () => {
  it('leaves a server free to join any hub when the policy says nothing', () => {
    const none = deriveFleetHubsPolicy(null)
    expect(none).toEqual({ restricted: false, allowed: [], managed: [] })
    expect(fleetHubAllowed(none, 'https://anything.example.org')).toBe(true)
    // The device namespace is not where the rule lives.
    expect(deriveFleetHubsPolicy({ customFields: { 'ion-desktop': { fleetHubs: { allowedUrls: [] } } } }).restricted).toBe(false)
  })

  it('limits a server to the organization\'s hub, and puts it there', () => {
    const p = deriveFleetHubsPolicy(policy({ allowedUrls: [], hubs: [{ url: 'https://hub.corp.example.org/', enrollmentToken: 'secretstore:hub-token' }] }))
    expect(p.restricted).toBe(true)
    expect(p.managed).toEqual([{ url: 'https://hub.corp.example.org', enrollmentToken: 'secretstore:hub-token', manage: true }])
    expect(fleetHubAllowed(p, 'https://hub.corp.example.org')).toBe(true)
    expect(fleetHubAllowed(p, 'https://hub.home.example.org')).toBe(false)
  })

  it('lets one machine\'s policy name a second hub its admin may add', () => {
    const p = deriveFleetHubsPolicy(policy({ allowedUrls: ['https://hub.home.example.org'], hubs: [{ url: 'https://hub.corp.example.org', enrollmentToken: 't', manage: false }] }))
    expect(fleetHubAllowed(p, 'https://hub.home.example.org')).toBe(true)
    expect(fleetHubAllowed(p, 'https://hub.other.example.org')).toBe(false)
    expect(p.managed[0].manage).toBe(false)
  })

  it('drops a managed hub with no address or no token, and a repeat', () => {
    const p = deriveFleetHubsPolicy(policy({ hubs: [{ url: 'nope', enrollmentToken: 't' }, { url: 'https://a.example.org' }, { url: 'https://b.example.org', enrollmentToken: 't' }, { url: 'https://B.example.org/', enrollmentToken: 'u' }] }))
    expect(p.managed.map((m) => m.url)).toEqual(['https://b.example.org'])
    expect(p.restricted).toBe(false)
  })
})

describe('isHubAction', () => {
  it('accepts only the actions a hub may ask for', () => {
    expect(isHubAction('fleet.refreshAccounts')).toBe(true)
    expect(isHubAction('environment.server.restart')).toBe(true)
    expect(isHubAction('provider.login')).toBe(false)
    expect(isHubAction(undefined)).toBe(false)
  })
})
