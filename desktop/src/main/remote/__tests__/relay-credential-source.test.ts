import { describe, expect, it, vi } from 'vitest'
import { RelayCredentialSource } from '../relay-credential-source'

const token = { ok: true, data: { accessToken: 'token', expiresAt: 1_800_000 } }

describe('RelayCredentialSource', () => {
  it('shares one forced refresh between concurrent relay reconnects', async () => {
    let resolve!: (value: typeof token) => void
    const requestToken = vi.fn(() => new Promise<typeof token>((done) => { resolve = done }))
    const source = new RelayCredentialSource('scope', requestToken, vi.fn(), vi.fn())
    source.requestForcedRefresh()

    const first = source.getCredential()
    const second = source.getCredential()
    resolve(token)

    await expect(Promise.all([first, second])).resolves.toEqual(['token', 'token'])
    expect(requestToken).toHaveBeenCalledOnce()
    expect(requestToken).toHaveBeenCalledWith('scope', true)
  })

  it('does not force later normal credential requests after success', async () => {
    const requestToken = vi.fn().mockResolvedValue(token)
    const source = new RelayCredentialSource('scope', requestToken, vi.fn(), vi.fn())
    source.requestForcedRefresh()

    await source.getCredential()
    await source.getCredential()

    expect(requestToken).toHaveBeenNthCalledWith(1, 'scope', true)
    expect(requestToken).toHaveBeenNthCalledWith(2, 'scope', false)
  })
})
