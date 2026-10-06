/** The `host` source — a signed-in CLI's token answers for its host, is reused briefly, and config can switch it off. */
import { describe, expect, it, vi } from 'vitest'
import { hostCredentialSource } from '../host'
import type { HostCliSignIn } from '../../host-cli'

const gh: HostCliSignIn = { tool: 'gh', host: 'github.com', account: 'example-user' }
const az: HostCliSignIn = { tool: 'az', host: 'dev.azure.com', account: 'user@example.org' }

describe('hostCredentialSource', () => {
  it('answers with the CLI token for a host the CLI is signed in to', async () => {
    const source = hostCredentialSource({ enabled: () => true, signIns: () => [gh], readToken: async () => 'gho_token' })
    expect(await source.resolve('local', 'github.com')).toEqual({ source: 'host', kind: 'https-token', host: 'github.com', token: 'gho_token', username: 'x-access-token' })
  })

  it('answers nothing for a host no CLI is signed in to, without running a CLI', async () => {
    const readToken = vi.fn(async () => 'gho_token')
    const source = hostCredentialSource({ enabled: () => true, signIns: () => [gh], readToken })
    expect(await source.resolve('local', 'gitlab.com')).toBeNull()
    expect(readToken).not.toHaveBeenCalled()
  })

  it('answers nothing when the CLI fails, and does not ask again until the answer expires', async () => {
    let now = 0
    const readToken = vi.fn(async (): Promise<string | null> => null)
    const source = hostCredentialSource({ enabled: () => true, signIns: () => [gh], readToken, now: () => now })
    expect(await source.resolve('local', 'github.com')).toBeNull()
    expect(await source.resolve('local', 'github.com')).toBeNull()
    expect(readToken).toHaveBeenCalledTimes(1)
    now = 6 * 60_000
    readToken.mockResolvedValue('gho_new')
    expect((await source.resolve('local', 'github.com'))?.token).toBe('gho_new')
    expect(readToken).toHaveBeenCalledTimes(2)
  })

  it('serves the az sign-in for every Azure DevOps host', async () => {
    const source = hostCredentialSource({ enabled: () => true, signIns: () => [az], readToken: async () => 'entra' })
    expect((await source.resolve('local', 'example.visualstudio.com'))?.token).toBe('entra')
    expect((await source.resolve('local', 'dev.azure.com'))?.username).toBe('oauth2')
  })

  it('answers nothing when host credentials are switched off', async () => {
    const readToken = vi.fn(async () => 'gho_token')
    const source = hostCredentialSource({ enabled: () => false, signIns: () => [gh], readToken })
    expect(await source.resolve('local', 'github.com')).toBeNull()
    expect(readToken).not.toHaveBeenCalled()
  })
})
