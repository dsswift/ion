import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Connection } from '../connection'
import type { StudioPrincipalSummary } from '@ion/shared/studio-wire/types'
import { setCurrentServerConfig, _resetCurrentServerConfigForTest } from '../../config/current'
import { loadServerConfig } from '../../config/server-config'
import { _resetGitCredentialStoreForTest, gitCredentialStore } from '../../git/identity/credential-store'
import { GIT_IDENTITY_ACTIONS } from '../git-identity-actions'
import { _resetGitlabExchangeCacheForTest } from '../../git/identity/sources/exchange-gitlab'

const { openAuthUrl } = vi.hoisted(() => ({ openAuthUrl: vi.fn() }))
vi.mock('../../oauth/url-opener', () => ({ openAuthUrl }))

function connFor(principal: StudioPrincipalSummary | null): Connection {
  return { id: 'conn-1', scopes: [], principal, send: () => true } as unknown as Connection
}

const alice: StudioPrincipalSummary = { subject: 'oidc:alice', displayName: 'Alice' }

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-git-identity-actions-test-'))
  _resetGitCredentialStoreForTest(dir)
  _resetGitlabExchangeCacheForTest()
  openAuthUrl.mockReset()
  openAuthUrl.mockResolvedValue(undefined)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  _resetCurrentServerConfigForTest()
})

describe('scopes', () => {
  it('requires git:write for every action', () => {
    for (const spec of Object.values(GIT_IDENTITY_ACTIONS)) {
      expect(spec.requiredScope).toBe('git:write')
    }
  })
})

describe('gitIdentity.mintSshKey / list / remove', () => {
  it('mints, lists, and removes a key for the connections own subject', async () => {
    const conn = connFor(alice)
    const minted = await GIT_IDENTITY_ACTIONS['gitIdentity.mintSshKey'].handler(conn, [{ host: 'github.com' }])
    expect(minted.ok).toBe(true)
    expect(minted.ok && (minted.value as { publicKey: string }).publicKey).toMatch(/^ssh-ed25519 /)

    const listed = await GIT_IDENTITY_ACTIONS['gitIdentity.list'].handler(conn, [])
    expect(listed.ok).toBe(true)
    expect(listed.ok && listed.value).toEqual([{ host: 'github.com', source: 'user', kind: 'ssh', publicKey: expect.stringMatching(/^ssh-ed25519 /), username: undefined }])

    const removed = await GIT_IDENTITY_ACTIONS['gitIdentity.remove'].handler(conn, [{ host: 'github.com' }])
    expect(removed.ok && removed.value).toEqual({ removed: true })
  })

  it('refuses a connection with no resolved principal', async () => {
    const result = await GIT_IDENTITY_ACTIONS['gitIdentity.mintSshKey'].handler(connFor(null), [{ host: 'github.com' }])
    expect(result.ok).toBe(false)
  })

  it('never lets a connection see another subjects credential', async () => {
    gitCredentialStore().set({ subject: 'oidc:bob', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'BOB-KEY', publicKey: 'p' })
    const listed = await GIT_IDENTITY_ACTIONS['gitIdentity.list'].handler(connFor(alice), [])
    expect(listed.ok && listed.value).toEqual([])
  })

  it('never accepts a subject from the payload -- only the connections own principal is used', async () => {
    const conn = connFor(alice)
    await GIT_IDENTITY_ACTIONS['gitIdentity.mintSshKey'].handler(conn, [{ host: 'github.com', subject: 'oidc:bob' }])
    expect(gitCredentialStore().get('oidc:alice', 'github.com')).toBeDefined()
    expect(gitCredentialStore().get('oidc:bob', 'github.com')).toBeUndefined()
  })
})

describe('gitIdentity.setToken', () => {
  it('stores a pasted token for the caller', async () => {
    const result = await GIT_IDENTITY_ACTIONS['gitIdentity.setToken'].handler(connFor(alice), [{ host: 'gitlab.example.com', token: 'glpat-x', username: 'alice' }])
    expect(result.ok).toBe(true)
    expect(gitCredentialStore().tokenFor('oidc:alice', 'gitlab.example.com')).toBe('glpat-x')
  })

  it('refuses missing host or token', async () => {
    const result = await GIT_IDENTITY_ACTIONS['gitIdentity.setToken'].handler(connFor(alice), [{ host: 'gitlab.example.com' }])
    expect(result.ok).toBe(false)
  })
})

describe('gitIdentity.authorize', () => {
  it('refuses an ADO host with no_authorize_needed', async () => {
    const result = await GIT_IDENTITY_ACTIONS['gitIdentity.authorize'].handler(connFor(alice), [{ host: 'dev.azure.com' }])
    expect(!result.ok && result.error.code).toBe('no_authorize_needed')
    expect(openAuthUrl).not.toHaveBeenCalled()
  })

  it('refuses when git.publicOrigin is not configured', async () => {
    setCurrentServerConfig(loadServerConfig(dir))
    const result = await GIT_IDENTITY_ACTIONS['gitIdentity.authorize'].handler(connFor(alice), [{ host: 'gitlab.example.com' }])
    expect(!result.ok && result.error.code).toBe('not_configured')
  })

  it('refuses a host with no matching exchange configured', async () => {
    const { writeFileSync } = await import('fs')
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ git: { publicOrigin: 'https://ion.example.com' } }))
    setCurrentServerConfig(loadServerConfig(dir))
    const result = await GIT_IDENTITY_ACTIONS['gitIdentity.authorize'].handler(connFor(alice), [{ host: 'gitlab.example.com' }])
    expect(!result.ok && result.error.code).toBe('exchange_not_configured')
  })

  it('opens the gitlab authorize URL via ion:open-auth-url when configured', async () => {
    const { writeFileSync } = await import('fs')
    const { writeSecretRef } = await import('../../config/secret-ref')
    writeSecretRef(dir, 'gitlab-secret', 'SECRET')
    writeFileSync(join(dir, 'server.json'), JSON.stringify({
      git: { publicOrigin: 'https://ion.example.com', exchange: { gitlab: { baseUrl: 'https://gitlab.example.com', clientId: 'app', clientSecretRef: 'secretstore:gitlab-secret' } } },
    }))
    setCurrentServerConfig(loadServerConfig(dir))

    const result = await GIT_IDENTITY_ACTIONS['gitIdentity.authorize'].handler(connFor(alice), [{ host: 'gitlab.example.com' }])
    expect(result.ok).toBe(true)
    expect(openAuthUrl).toHaveBeenCalledTimes(1)
    const conn = openAuthUrl.mock.calls[0][1] as Connection
    expect(openAuthUrl.mock.calls[0][0]).toContain('https://gitlab.example.com/oauth/authorize?')
    // The requester is named so a phone gets the URL back instead of a broadcast, and every caller gets it in the result.
    expect(conn.principal).toEqual(alice)
    expect(result.ok && result.value).toEqual({ started: true, authorizationUrl: openAuthUrl.mock.calls[0][0] })
  })
})
