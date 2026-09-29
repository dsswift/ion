import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startHealth, type HealthHandle } from '../health'
import type { ServerGitConfig } from '../../config/server-config'

const { completeGitlabAuthorize } = vi.hoisted(() => ({ completeGitlabAuthorize: vi.fn() }))
vi.mock('../../git/identity/sources/exchange-gitlab', () => ({ completeGitlabAuthorize }))
const { completeGithubAuthorize } = vi.hoisted(() => ({ completeGithubAuthorize: vi.fn() }))
vi.mock('../../git/identity/sources/exchange-github', () => ({ completeGithubAuthorize }))

import { authGitCallbackRoute } from '../auth-git-callback'

const GIT: ServerGitConfig = {
  credentials: [],
  publicOrigin: 'https://ion.example.com',
  exchange: {
    ado: { enabled: false },
    gitlab: { baseUrl: 'https://gitlab.example.com', clientId: 'app', clientSecret: 'secret' },
    github: { clientId: 'app', clientSecret: 'secret' },
  },
}

let health: HealthHandle

function baseUrl(h: HealthHandle): string {
  const address = h.tcpServer?.address()
  if (!address || typeof address === 'string') throw new Error('expected an AddressInfo from the ephemeral TCP listener')
  return `http://127.0.0.1:${address.port}`
}

beforeEach(() => {
  completeGitlabAuthorize.mockReset()
  completeGithubAuthorize.mockReset()
  health = startHealth({ port: 0, routes: { '/auth/git/callback': authGitCallbackRoute(() => GIT) } })
})

afterEach(async () => {
  await health.close()
})

describe('GET /auth/git/callback', () => {
  it('completes a gitlab authorization and returns 200', async () => {
    completeGitlabAuthorize.mockResolvedValueOnce({ ok: true, subject: 'oidc:alice', host: 'gitlab.example.com' })
    const res = await fetch(`${baseUrl(health)}/auth/git/callback?provider=gitlab&code=abc&state=xyz`, { headers: { Connection: 'close' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('gitlab.example.com')
    expect(completeGitlabAuthorize).toHaveBeenCalledWith(GIT.exchange.gitlab, { origin: 'https://ion.example.com', code: 'abc', state: 'xyz' })
  })

  it('completes a github authorization and returns 200', async () => {
    completeGithubAuthorize.mockResolvedValueOnce({ ok: true, subject: 'oidc:alice', host: 'github.com' })
    const res = await fetch(`${baseUrl(health)}/auth/git/callback?provider=github&code=abc&state=xyz`, { headers: { Connection: 'close' } })
    expect(res.status).toBe(200)
    expect(completeGithubAuthorize).toHaveBeenCalledWith(GIT.exchange.github, { origin: 'https://ion.example.com', code: 'abc', state: 'xyz' })
  })

  it('400s when the exchange refuses (e.g. unknown state)', async () => {
    completeGitlabAuthorize.mockResolvedValueOnce({ ok: false, reason: 'unknown_state' })
    const res = await fetch(`${baseUrl(health)}/auth/git/callback?provider=gitlab&code=abc&state=xyz`, { headers: { Connection: 'close' } })
    expect(res.status).toBe(400)
  })

  it('400s for missing code/state', async () => {
    const res = await fetch(`${baseUrl(health)}/auth/git/callback?provider=gitlab`, { headers: { Connection: 'close' } })
    expect(res.status).toBe(400)
  })

  it('400s for an unknown provider', async () => {
    const res = await fetch(`${baseUrl(health)}/auth/git/callback?provider=bitbucket&code=abc&state=xyz`, { headers: { Connection: 'close' } })
    expect(res.status).toBe(400)
  })

  it('never calls the wrong providers exchange function', async () => {
    completeGithubAuthorize.mockResolvedValueOnce({ ok: true, subject: 'oidc:alice', host: 'github.com' })
    await fetch(`${baseUrl(health)}/auth/git/callback?provider=github&code=abc&state=xyz`, { headers: { Connection: 'close' } })
    expect(completeGitlabAuthorize).not.toHaveBeenCalled()
  })
})
