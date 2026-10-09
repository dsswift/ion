/**
 * tabs-index — the three fail-open-turned-fail-closed sites (A3) and the new
 * conversation-ownership index (A2b) all live here, so their unit coverage
 * does too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetPrincipalIndexForTest,
  principalSubjectForConversation,
  principalSubjectForTab,
  tabVisibleTo,
} from '../tabs-index'
import { _resetCurrentServerConfigForTest, currentServerConfig, setCurrentServerConfig } from '../../config/current'
import type { ServerOidcConfig } from '../../config/server-config'

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

let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(() => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-tabs-index-'))
  process.env.ION_DATA_DIR = dataDir
})

afterEach(() => {
  _resetPrincipalIndexForTest()
  _resetCurrentServerConfigForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function writeTabsFile(body: Record<string, unknown>): void {
  writeFileSync(join(dataDir, 'tabs.json'), JSON.stringify(body))
}

function enableMultiTenant(): void {
  setCurrentServerConfig({ ...currentServerConfig(), oidc })
}

describe('tabVisibleTo — unresolved-owner fail-open/fail-closed', () => {
  const alice = { subject: 'local:alice', displayName: 'alice' }

  it('an owned tab is visible only to its owner, regardless of tenancy mode', () => {
    const tab = { id: 't1', conversationId: null, principalSubject: 'local:bob' } as never
    expect(tabVisibleTo(tab, alice)).toBe(false)
    enableMultiTenant()
    expect(tabVisibleTo(tab, alice)).toBe(false)
  })

  it('an unowned (legacy) tab is visible to everyone in single-tenant mode', () => {
    const tab = { id: 't1', conversationId: null } as never
    expect(tabVisibleTo(tab, alice)).toBe(true)
  })

  it('an unowned (legacy) tab is visible to no one once the server is multi-tenant', () => {
    enableMultiTenant()
    const tab = { id: 't1', conversationId: null } as never
    expect(tabVisibleTo(tab, alice)).toBe(false)
  })

  it('FR-02: an owned tab is visible to a non-owner once tenancy.mode is shared', () => {
    setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'shared' } })
    const tab = { id: 't1', conversationId: null, principalSubject: 'local:bob' } as never
    expect(tabVisibleTo(tab, alice)).toBe(true)
  })

  it('FR-02: shared tenancy overrides multi-tenant unowned-tab fail-closed too', () => {
    setCurrentServerConfig({ ...currentServerConfig(), oidc, tenancy: { mode: 'shared' } })
    const tab = { id: 't1', conversationId: null } as never
    expect(tabVisibleTo(tab, alice)).toBe(true)
  })

  it('tenancy.mode "isolated" (the default) behaves exactly like an absent tenancy block', () => {
    setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'isolated' } })
    const tab = { id: 't1', conversationId: null, principalSubject: 'local:bob' } as never
    expect(tabVisibleTo(tab, alice)).toBe(false)
  })
})

describe('principalSubjectForTab — corrupt tabs.json degrades to no isolation, not all isolation', () => {
  it('single-tenant: an unresolvable tab (corrupt file) has no recorded owner but stays fail-open at the caller (tabVisibleTo)', () => {
    writeFileSync(join(dataDir, 'tabs.json'), '{ not valid json')
    expect(principalSubjectForTab('any-tab')).toBeUndefined()
  })

  it('multi-tenant: every tab is invisible while tabs.json is corrupt, not visible to everyone', () => {
    enableMultiTenant()
    writeTabsFile({ tabs: [{ id: 't1', conversationId: null, principalSubject: 'local:alice' }] })
    expect(tabVisibleTo({ id: 't1', conversationId: null } as never, { subject: 'local:bob', displayName: 'bob' })).toBe(false)

    // Now corrupt the file: t1's real owner is unreadable.
    writeFileSync(join(dataDir, 'tabs.json'), '{ not valid json')
    _resetPrincipalIndexForTest()
    expect(principalSubjectForTab('t1')).toBeUndefined()
    // The caller-side rule (tabVisibleTo / events.ts / snapshot.ts) is what
    // turns "unresolved" into "invisible" — asserted directly here since
    // tabVisibleTo takes the raw tab record, not just an id.
    const unresolved = { id: 't1', conversationId: null } as never
    expect(tabVisibleTo(unresolved, { subject: 'local:alice', displayName: 'alice' })).toBe(false)
  })
})

describe('principalSubjectForTab — settled records', () => {
  it('resolves the owner of a settled conversation by its tab id', () => {
    writeTabsFile({
      tabs: [{ id: 't1', conversationId: 'conv-1', principalSubject: 'local:alice' }],
      settledHistory: [{ id: 't-settled', conversationId: 'conv-old', principalSubject: 'local:bob' }],
    })
    expect(principalSubjectForTab('t-settled')).toBe('local:bob')
    expect(principalSubjectForTab('t1')).toBe('local:alice')
  })
})

describe('principalSubjectForConversation — A2b conversation ownership index', () => {
  it('resolves a live tab\'s current conversationId', () => {
    writeTabsFile({ tabs: [{ id: 't1', conversationId: 'conv-1', principalSubject: 'local:alice' }] })
    expect(principalSubjectForConversation('conv-1')).toBe('local:alice')
  })

  it('resolves every id in historicalSessionIds to the same owner', () => {
    writeTabsFile({
      tabs: [{ id: 't1', conversationId: 'conv-current', historicalSessionIds: ['conv-old-1', 'conv-old-2'], principalSubject: 'local:alice' }],
    })
    expect(principalSubjectForConversation('conv-old-1')).toBe('local:alice')
    expect(principalSubjectForConversation('conv-old-2')).toBe('local:alice')
  })

  it('resolves a SETTLED (closed) tab\'s conversationId — the case session.deleteStored actually targets', () => {
    writeTabsFile({
      tabs: [],
      settledHistory: [{ id: 't-closed', conversationId: 'conv-closed', principalSubject: 'local:alice' }],
    })
    expect(principalSubjectForConversation('conv-closed')).toBe('local:alice')
  })

  it('is undefined for a conversation id no live or settled tab names', () => {
    writeTabsFile({ tabs: [{ id: 't1', conversationId: 'conv-1', principalSubject: 'local:alice' }] })
    expect(principalSubjectForConversation('conv-unknown')).toBeUndefined()
  })
})
