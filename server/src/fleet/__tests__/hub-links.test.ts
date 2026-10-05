/** Which hubs a server reports to: the policy's, and the ones its admin added that the policy allows. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { FleetHubLinks } from '../hub-links'
import { FleetHubStore } from '../hub-store'
import type { HubLink, HubLinkOptions } from '../hub-link'

let dir: string
let store: FleetHubStore
let policy: EnterprisePolicy | null
let made: Array<{ options: HubLinkOptions; closed: boolean; open: boolean; deploys: unknown[]; installs: unknown[] }>
let links: FleetHubLinks

const policyOf = (fleetHubs: unknown): EnterprisePolicy => ({ customFields: { 'ion-server': { fleetHubs } } }) as EnterprisePolicy
const running = (): string[] => made.filter((m) => !m.closed).map((m) => m.options.url)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-hub-links-test-'))
  store = new FleetHubStore(dir)
  policy = null
  made = []
  links = new FleetHubLinks({
    store,
    policy: () => policy,
    resolveSecret: (ref) => (ref === 'secretstore:corp' ? 'corp-token' : ref === 'secretstore:missing' ? '' : ref),
    environmentId: () => 'env-1',
    label: 'server one',
    reportSeconds: 60,
    buildReport: async () => { throw new Error('unused') },
    runAction: async () => ({ ok: true, value: null }),
    createLink: (options) => {
      const entry = { options, closed: false, open: true, deploys: [] as unknown[], installs: [] as unknown[] }
      made.push(entry)
      return {
        url: options.url, manage: options.manage, start: () => {}, close: () => { entry.closed = true }, status: () => ({ state: 'connecting', hubLabel: null }),
        sendDeploy: (deploy: unknown) => { if (entry.open) entry.deploys.push(deploy); return entry.open },
        sendInstall: (progress: unknown) => { if (entry.open) entry.installs.push(progress); return entry.open },
      } as unknown as HubLink
    },
  })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('FleetHubLinks', () => {
  it('reports to every hub an admin added when the policy says nothing', () => {
    expect(links.add({ url: 'https://hub.home.example.org', enrollmentToken: 'home-enrollment-token', manage: true })).toEqual({ ok: true })
    expect(links.add({ url: 'https://hub.lab.example.org', enrollmentToken: 't2', manage: false })).toEqual({ ok: true })
    expect(running()).toEqual(['https://hub.home.example.org', 'https://hub.lab.example.org'])
    expect(links.list()).toMatchObject({ restricted: false, hubs: [{ url: 'https://hub.home.example.org', source: 'added', manage: true }, { url: 'https://hub.lab.example.org', source: 'added', manage: false }] })
    // The token is sealed on disk, never written as it was typed.
    expect(readFileSync(join(dir, 'fleet-hubs.json'), 'utf-8')).not.toContain('home-enrollment-token')
  })

  it('reports under the name the hub was added with, else the server\'s own', () => {
    links.add({ url: 'https://hub.home.example.org', enrollmentToken: 't1', manage: true, label: 'win-arm64' })
    links.add({ url: 'https://hub.lab.example.org', enrollmentToken: 't2', manage: true })
    expect(made.map((m) => m.options.label)).toEqual(['win-arm64', 'server one'])
    expect(new FleetHubStore(dir).added().map((h) => h.label)).toEqual(['win-arm64', undefined])
  })

  it('puts the server on the organization\'s hub, and refuses any other', () => {
    policy = policyOf({ allowedUrls: [], hubs: [{ url: 'https://hub.corp.example.org', enrollmentToken: 'secretstore:corp' }] })
    links.reconcile()
    expect(made[0].options).toMatchObject({ url: 'https://hub.corp.example.org', enrollmentToken: 'corp-token', manage: true })
    expect(links.add({ url: 'https://hub.home.example.org', enrollmentToken: 't', manage: true })).toMatchObject({ ok: false, code: 'not_allowed' })
    expect(links.add({ url: 'https://hub.corp.example.org', enrollmentToken: 't', manage: true })).toMatchObject({ ok: false, code: 'policy_hub' })
    expect(links.remove('https://hub.corp.example.org')).toBe(false)
    expect(running()).toEqual(['https://hub.corp.example.org'])
    expect(links.list()).toMatchObject({ restricted: true, hubs: [{ source: 'policy' }] })
  })

  it('lets a machine whose policy names a second hub report to both', () => {
    policy = policyOf({ allowedUrls: ['https://hub.home.example.org'], hubs: [{ url: 'https://hub.corp.example.org', enrollmentToken: 'secretstore:corp' }] })
    links.reconcile()
    expect(links.add({ url: 'https://hub.home.example.org', enrollmentToken: 't', manage: true })).toEqual({ ok: true })
    expect(running()).toEqual(['https://hub.corp.example.org', 'https://hub.home.example.org'])
  })

  it('stops reporting to a hub the policy no longer allows, and says so', () => {
    links.add({ url: 'https://hub.home.example.org', enrollmentToken: 't', manage: true })
    policy = policyOf({ allowedUrls: [] })
    links.reconcile()
    expect(running()).toEqual([])
    expect(links.list().hubs).toEqual([expect.objectContaining({ url: 'https://hub.home.example.org', state: 'blocked' })])
    // Allowed again: the hub the admin added is dialed again.
    policy = null
    links.reconcile()
    expect(running()).toEqual(['https://hub.home.example.org'])
  })

  it('skips a policy hub whose token cannot be resolved', () => {
    policy = policyOf({ hubs: [{ url: 'https://hub.corp.example.org', enrollmentToken: 'secretstore:missing' }] })
    links.reconcile()
    expect(running()).toEqual([])
  })

  it('stops a hub that is removed and forgets its credential', () => {
    links.add({ url: 'https://hub.home.example.org', enrollmentToken: 't', manage: true })
    store.setCredential('https://hub.home.example.org', 'issued')
    expect(links.remove('https://hub.home.example.org')).toBe(true)
    expect(running()).toEqual([])
    expect(store.credential('https://hub.home.example.org')).toBeNull()
    expect(store.added()).toEqual([])
  })

  it('passes a deploy and an install step to every hub, and tells a hub that connects late what still stands', () => {
    links.add({ url: 'https://hub.home.example.org', enrollmentToken: 't1', manage: true })
    links.add({ url: 'https://hub.lab.example.org', enrollmentToken: 't2', manage: false })
    made[1].open = false
    const running = { id: 'd1', source: 'build of ion', startedAt: 1, updatedAt: 1, state: 'running' as const, targets: [] }
    const install = { stage: 'installing' as const, kind: 'release' as const, at: Date.now() }
    links.deploy(running)
    links.install(install)
    expect(made[0].deploys).toEqual([running])
    expect(made[0].installs).toEqual([install])
    expect(made[1].deploys).toEqual([])
    // The hub that was not connected asks what stands when it welcomes the server.
    expect(made[1].options.standing?.()).toEqual({ deploys: [running], install })
    // A finished deploy is no longer standing; an install step that is old news is not either.
    links.deploy({ ...running, state: 'done', updatedAt: 2 })
    links.install({ ...install, at: Date.now() - 31 * 60_000 })
    expect(made[1].options.standing?.()).toEqual({ deploys: [], install: null })
  })
})
