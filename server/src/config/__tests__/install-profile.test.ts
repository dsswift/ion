import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installProfile } from '../install-profile'
import { defaultServerConfig, loadServerConfig } from '../server-config'
import { setCurrentServerConfig, isSharedTenancy, sharedTenancyIsExplicit, noteEnginePrincipalPartitioning, _resetCurrentServerConfigForTest } from '../current'
import { tabVisibleTo } from '../../protocol/tabs-index'
import { pairedPrincipal } from '../../auth/paired'
import { userInfo } from 'os'

// The shared-tenancy fold now checks the engine's signed-in Entra identity
// before falling back to the OS username (resolveLocalConnectionPrincipal).
// This suite exercises profile/tenancy behavior, not identity precedence, so
// the engine round trip is mocked to "nobody signed in" -- see
// server/src/protocol/__tests__/hello.test.ts for the precedence test.
vi.mock('../../oauth/entra-flow', () => ({ getSignedInIdentityIfEngineConnected: vi.fn().mockResolvedValue(null) }))

let dir: string
let original: string | undefined

beforeEach(() => { original = process.env.ION_STUDIO_PROFILE; dir = mkdtempSync(join(tmpdir(), 'ion-profile-')) })
afterEach(() => {
  if (original === undefined) delete process.env.ION_STUDIO_PROFILE
  else process.env.ION_STUDIO_PROFILE = original
  _resetCurrentServerConfigForTest()
  rmSync(dir, { recursive: true, force: true })
})

const ownersTab = { id: 't1', principalSubject: 'local:owner' } as never
const pairedDevice = { subject: 'paired:laptop-2', displayName: 'laptop 2' }

describe('install profile', () => {
  it('is standard unless the launcher says personal', () => {
    expect(installProfile({})).toBe('standard')
    expect(installProfile({ ION_STUDIO_PROFILE: 'personal' })).toBe('personal')
    expect(installProfile({ ION_STUDIO_PROFILE: 'team' })).toBe('standard')
  })

  // A desktop's built-in server has no server.json. Without the profile a
  // second laptop paired to it saw none of the owner's conversations and
  // could not administer the install.
  it('personal: a paired device sees the owner\'s conversations, acts as the owner, and may administer', async () => {
    process.env.ION_STUDIO_PROFILE = 'personal'
    const config = loadServerConfig(dir)
    setCurrentServerConfig(config)
    expect(config.pairing.defaultScopes).toContain('admin')
    expect(isSharedTenancy()).toBe(true)
    expect(sharedTenancyIsExplicit()).toBe(false)
    expect(tabVisibleTo(ownersTab, pairedDevice)).toBe(true)
    const principal = await pairedPrincipal({ clientId: 'c1', subject: 'paired:laptop-2', label: 'laptop 2' })
    expect(principal.subject).toBe(`local:${userInfo().username}`)
  })

  it('standard: isolation stays the default', () => {
    delete process.env.ION_STUDIO_PROFILE
    const config = defaultServerConfig()
    setCurrentServerConfig(config)
    expect(config.pairing.defaultScopes).not.toContain('admin')
    expect(isSharedTenancy()).toBe(false)
    expect(tabVisibleTo(ownersTab, pairedDevice)).toBe(false)
  })

  it('an explicit server.json wins over the profile, in both directions', () => {
    process.env.ION_STUDIO_PROFILE = 'personal'
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ tenancy: { mode: 'isolated' }, pairing: { defaultScopes: ['conversations:read'] } }))
    const config = loadServerConfig(dir)
    setCurrentServerConfig(config)
    expect(isSharedTenancy()).toBe(false)
    expect(config.pairing.defaultScopes).toEqual(['conversations:read'])
  })

  it('the shared default steps back when the engine partitions storage per principal; an explicit shared does not', () => {
    process.env.ION_STUDIO_PROFILE = 'personal'
    setCurrentServerConfig(loadServerConfig(dir))
    noteEnginePrincipalPartitioning(true)
    expect(isSharedTenancy()).toBe(false)
    noteEnginePrincipalPartitioning(false)
    expect(isSharedTenancy()).toBe(true)

    writeFileSync(join(dir, 'server.json'), JSON.stringify({ tenancy: { mode: 'shared' } }))
    setCurrentServerConfig(loadServerConfig(dir))
    noteEnginePrincipalPartitioning(true)
    expect(isSharedTenancy()).toBe(true)
    expect(sharedTenancyIsExplicit()).toBe(true)
  })
})
