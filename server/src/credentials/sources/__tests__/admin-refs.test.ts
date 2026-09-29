import { describe, expect, it } from 'vitest'
import { adminRefsSource } from '../admin-refs'
import type { ServerGitCredentialConfig, ServerProviderCredentialConfig } from '../../../config/server-config'

describe('adminRefsSource: provider axis', () => {
  it('resolves a provider credential entry matching subject and provider', () => {
    const entries: ServerProviderCredentialConfig[] = [
      { subject: 'oidc:alice', provider: 'anthropic', value: 'sk-alice', header: 'x-api-key' },
    ]
    const source = adminRefsSource(() => entries, () => [])
    const result = source.resolve({ subject: 'oidc:alice', axis: { kind: 'provider', provider: 'anthropic' } })
    expect(result).toEqual({ source: 'admin', value: { kind: 'provider', token: 'sk-alice', header: 'x-api-key' } })
  })

  it('returns null when no provider entry matches subject and provider', () => {
    const source = adminRefsSource(() => [], () => [])
    expect(source.resolve({ subject: 'oidc:alice', axis: { kind: 'provider', provider: 'anthropic' } })).toBeNull()
  })

  it('never returns another subjects provider entry for the same provider id', () => {
    const entries: ServerProviderCredentialConfig[] = [
      { subject: 'oidc:bob', provider: 'anthropic', value: 'sk-bob' },
    ]
    const source = adminRefsSource(() => entries, () => [])
    expect(source.resolve({ subject: 'oidc:alice', axis: { kind: 'provider', provider: 'anthropic' } })).toBeNull()
  })
})

describe('adminRefsSource: git axis (folded from the former git-only admin-refs source)', () => {
  it('resolves an ssh entry matching subject and host', () => {
    const entries: ServerGitCredentialConfig[] = [
      { subject: 'oidc:alice', host: 'github.com', kind: 'ssh', privateKey: 'KEY', publicKey: 'PUB' },
    ]
    const source = adminRefsSource(() => [], () => entries)
    const result = source.resolve({ subject: 'oidc:alice', axis: { kind: 'git', host: 'github.com' } })
    expect(result).toEqual({
      source: 'admin',
      value: { kind: 'git', cred: { source: 'admin', kind: 'ssh', host: 'github.com', privateKey: 'KEY', publicKey: 'PUB' } },
    })
  })

  it('resolves an https-token entry', () => {
    const entries: ServerGitCredentialConfig[] = [
      { subject: 'oidc:alice', host: 'gitlab.example.com', kind: 'https-token', token: 'PAT', username: 'ci-bot' },
    ]
    const source = adminRefsSource(() => [], () => entries)
    const result = source.resolve({ subject: 'oidc:alice', axis: { kind: 'git', host: 'gitlab.example.com' } })
    expect(result).toEqual({
      source: 'admin',
      value: { kind: 'git', cred: { source: 'admin', kind: 'https-token', host: 'gitlab.example.com', token: 'PAT', username: 'ci-bot' } },
    })
  })

  it('returns null when no git entry matches subject and host', () => {
    const source = adminRefsSource(() => [], () => [])
    expect(source.resolve({ subject: 'oidc:alice', axis: { kind: 'git', host: 'github.com' } })).toBeNull()
  })

  it('never returns another subjects git entry for the same host', () => {
    const entries: ServerGitCredentialConfig[] = [
      { subject: 'oidc:bob', host: 'github.com', kind: 'ssh', privateKey: 'BOB-KEY', publicKey: 'BOB-PUB' },
    ]
    const source = adminRefsSource(() => [], () => entries)
    expect(source.resolve({ subject: 'oidc:alice', axis: { kind: 'git', host: 'github.com' } })).toBeNull()
  })

  it('returns null for an ssh entry missing its resolved private key', () => {
    const entries: ServerGitCredentialConfig[] = [
      { subject: 'oidc:alice', host: 'github.com', kind: 'ssh' },
    ]
    const source = adminRefsSource(() => [], () => entries)
    expect(source.resolve({ subject: 'oidc:alice', axis: { kind: 'git', host: 'github.com' } })).toBeNull()
  })
})
