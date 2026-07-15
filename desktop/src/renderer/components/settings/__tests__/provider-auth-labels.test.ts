import { describe, it, expect } from 'vitest'
import {
  humanAuthSource, providerAuthBadge, backendLabel, PROVIDER_BACKENDS, providerCliBackend,
} from '../provider-auth-labels'
import type { ProviderEntry } from '../../../../shared/types-models'

describe('humanAuthSource', () => {
  it('maps the delegated-CLI auth sources', () => {
    expect(humanAuthSource('claude-code')).toBe('Claude Code')
    expect(humanAuthSource('codex')).toBe('ChatGPT')
    expect(humanAuthSource('grok')).toBe('Grok CLI')
    expect(humanAuthSource('cursor')).toBe('Cursor')
  })

  it('no longer has a legacy "cli" mapping (renamed to claude-code)', () => {
    // Regression: the engine emits "claude-code", never "cli". A stray "cli"
    // must fall through to the generic label, not a hardcoded "Claude CLI".
    expect(humanAuthSource('cli')).toBe('configured')
  })
})

function entry(over: Partial<ProviderEntry>): ProviderEntry {
  return { id: 'openai', hasAuth: true, ...over }
}

describe('providerAuthBadge', () => {
  it('composes the CLI label with the account email when authed via CLI', () => {
    const p = entry({ authSource: 'codex', cli: { backend: 'codex', installed: true, authenticated: true, label: 'ChatGPT Pro', email: 'josh@example.com' } })
    expect(providerAuthBadge(p)).toBe('ChatGPT Pro · josh@example.com')
  })

  it('uses the CLI label without email when no email is present', () => {
    const p = entry({ authSource: 'codex', cli: { backend: 'codex', installed: true, authenticated: true, label: 'ChatGPT Pro' } })
    expect(providerAuthBadge(p)).toBe('ChatGPT Pro')
  })

  it('falls back to the generic label for a plain API key', () => {
    expect(providerAuthBadge(entry({ authSource: 'filestore' }))).toBe('API key')
  })

  it('reads "not configured" when unauthenticated', () => {
    expect(providerAuthBadge(entry({ hasAuth: false }))).toBe('not configured')
  })
})

describe('backend metadata', () => {
  it('offers two backends for anthropic/openai/xai and one for cursor', () => {
    expect(PROVIDER_BACKENDS.anthropic).toEqual(['api', 'claude-code'])
    expect(PROVIDER_BACKENDS.openai).toEqual(['api', 'codex'])
    expect(PROVIDER_BACKENDS.xai).toEqual(['api', 'grok'])
    expect(PROVIDER_BACKENDS.cursor).toEqual(['cursor'])
  })

  it('maps providers to their CLI backend kind', () => {
    expect(providerCliBackend('openai')).toBe('codex')
    expect(providerCliBackend('anthropic')).toBe('claude-code')
    expect(providerCliBackend('google')).toBeUndefined()
  })

  it('labels backend kinds for the segmented control', () => {
    expect(backendLabel('claude-code')).toBe('Claude Code')
    expect(backendLabel('codex')).toBe('ChatGPT')
    expect(backendLabel('api')).toBe('API')
  })
})
