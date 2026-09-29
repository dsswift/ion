import { afterEach, describe, expect, it } from 'vitest'
import {
  registerPrincipalSource,
  resolvePrincipalCredential,
  resolveFromSourceList,
  _unregisterAllPrincipalSourcesForTest,
  type PrincipalCredentialSource,
} from '../principal-source'

afterEach(() => {
  _unregisterAllPrincipalSourcesForTest()
})

describe('resolvePrincipalCredential: precedence', () => {
  it('returns null when no source has a credential', async () => {
    const result = await resolvePrincipalCredential({ subject: 'oidc:alice', axis: { kind: 'provider', provider: 'anthropic' } })
    expect(result).toBeNull()
  })

  it('resolves both axes through one registrable interface', async () => {
    const provider: PrincipalCredentialSource = {
      name: 'test-provider',
      resolve: (scope) =>
        scope.axis.kind === 'provider' && scope.subject === 'oidc:alice' && scope.axis.provider === 'anthropic'
          ? { source: 'test-provider', value: { kind: 'provider', token: 'sk-alice' } }
          : null,
    }
    registerPrincipalSource(provider)

    const providerResult = await resolvePrincipalCredential({ subject: 'oidc:alice', axis: { kind: 'provider', provider: 'anthropic' } })
    expect(providerResult?.value).toEqual({ kind: 'provider', token: 'sk-alice' })

    const gitResult = await resolvePrincipalCredential({ subject: 'oidc:alice', axis: { kind: 'git', host: 'github.com' } })
    expect(gitResult).toBeNull()
  })

  it('registration order is precedence order: the first source to answer wins', async () => {
    registerPrincipalSource({
      name: 'first',
      resolve: () => ({ source: 'first', value: { kind: 'provider', token: 'FIRST' } }),
    })
    registerPrincipalSource({
      name: 'second',
      resolve: () => ({ source: 'second', value: { kind: 'provider', token: 'SECOND' } }),
    })

    const result = await resolvePrincipalCredential({ subject: 'oidc:alice', axis: { kind: 'provider', provider: 'anthropic' } })
    expect(result?.source).toBe('first')
  })

  it('a malformed/throwing source is skipped with a warning and the remaining entries still resolve', async () => {
    registerPrincipalSource({
      name: 'broken',
      resolve: () => {
        throw new Error('boom')
      },
    })
    registerPrincipalSource({
      name: 'healthy',
      resolve: () => ({ source: 'healthy', value: { kind: 'provider', token: 'OK' } }),
    })

    const result = await resolvePrincipalCredential({ subject: 'oidc:alice', axis: { kind: 'provider', provider: 'anthropic' } })
    expect(result?.source).toBe('healthy')
  })

  it('registering the same name twice replaces the prior instance in place rather than duplicating it', async () => {
    registerPrincipalSource({ name: 'x', resolve: () => ({ source: 'x', value: { kind: 'provider', token: 'FIRST' } }) })
    registerPrincipalSource({ name: 'x', resolve: () => ({ source: 'x', value: { kind: 'provider', token: 'REPLACED' } }) })

    const result = await resolvePrincipalCredential({ subject: 'oidc:alice', axis: { kind: 'provider', provider: 'anthropic' } })
    expect(result?.value).toEqual({ kind: 'provider', token: 'REPLACED' })
  })

  it('never logs a credential value (secrets gate)', async () => {
    const logged: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
    try {
      registerPrincipalSource({
        name: 'test',
        resolve: () => ({ source: 'test', value: { kind: 'provider', token: 'sk-super-secret-value-123456' } }),
      })
      await resolvePrincipalCredential({ subject: 'oidc:alice', axis: { kind: 'provider', provider: 'anthropic' } })
    } finally {
      console.log = origLog
    }
    for (const line of logged) {
      expect(line).not.toContain('sk-super-secret-value-123456')
    }
  })
})

describe('resolveFromSourceList: the shared sequential-walk algorithm', () => {
  it('awaits sources sequentially, never racing a slower higher-precedence source', async () => {
    const order: string[] = []
    const slow = { name: 'slow', resolve: async () => { await new Promise((r) => setTimeout(r, 20)); order.push('slow'); return null } }
    const fast = { name: 'fast', resolve: () => { order.push('fast'); return 'FAST-RESULT' } }

    const found = await resolveFromSourceList([slow, fast], (s) => s.resolve(), {})
    expect(order).toEqual(['slow', 'fast'])
    expect(found?.result).toBe('FAST-RESULT')
  })
})
