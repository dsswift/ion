/**
 * Tests for the user-message command-PILL decision (`resolveSlashPill` in
 * `../slash-pill.ts`, the pure helper `MessageBubble` / `QueuedMessage` use).
 *
 * These pin the post-engine-ownership pill contract:
 *
 *   1. A Message with `slashCommand: '/diagram'` renders the pill labelled
 *      `/diagram` — and the decision is INDEPENDENT of `enableClaudeCompat`.
 *      `resolveSlashPill` takes no preferences argument, so there is no
 *      compat gate to fail; we assert the same result regardless of any
 *      ambient compat value (modelled here as two explicit cases).
 *
 *   2. A plain message whose `content` starts with `/x` and carries NO
 *      `slashCommand` metadata still pills via the fallback content parse
 *      (extension commands / optimistic bubbles before metadata arrives).
 *
 * Pure-function tests: no jsdom / React render needed (the repo's vitest env
 * is `node` and has no testing-library), and the pill DECISION — not the DOM
 * — is the behaviour the change owns.
 */

import { describe, it, expect } from 'vitest'
import { resolveSlashPill, parseSlashCommand, formatSlashModelDisplay } from '../slash-pill'
import type { Message } from '../../../../shared/types'

function msg(partial: Partial<Message>): Message {
  return {
    id: 'm1',
    role: 'user',
    content: '',
    timestamp: 0,
    ...partial,
  }
}

describe('resolveSlashPill — engine metadata (slashCommand)', () => {
  it('renders the pill labelled /diagram from slashCommand metadata', () => {
    const m = msg({ slashCommand: '/diagram', content: '/diagram the auth flow' })
    const pill = resolveSlashPill(m, m.content)
    expect(pill).not.toBeNull()
    expect(pill!.command).toBe('/diagram')
    // Body = raw content with the label stripped (no slashArgs present).
    expect(pill!.args).toBe('the auth flow')
  })

  it('prefers explicit slashArgs for the pill body when present', () => {
    const m = msg({ slashCommand: '/diagram', slashArgs: 'the auth flow', content: '/diagram the auth flow' })
    const pill = resolveSlashPill(m, m.content)
    expect(pill).toEqual({ command: '/diagram', args: 'the auth flow', modelDisplay: null })
  })

  it('renders the /diagram pill REGARDLESS of any enableClaudeCompat value', () => {
    // The decision is a pure function of the message — there is no compat
    // gate. We model "compat on" and "compat off" by asserting the same
    // result holds no matter what the caller's ambient setting is.
    const m = msg({ slashCommand: '/diagram', content: '/diagram x' })
    for (const _enableClaudeCompat of [true, false]) {
      const pill = resolveSlashPill(m, m.content)
      expect(pill!.command).toBe('/diagram')
    }
  })

  it('renders a metadata pill even when content is just the bare label (empty body)', () => {
    const m = msg({ slashCommand: '/clear', content: '/clear' })
    const pill = resolveSlashPill(m, m.content)
    expect(pill).toEqual({ command: '/clear', args: '', modelDisplay: null })
  })

  it('includes model provenance when slashModelAlias and slashModelEffective are set', () => {
    const m = msg({ slashCommand: '/diagram', slashArgs: 'auth flow', slashModelAlias: 'Standard', slashModelEffective: 'GPT-5.6 Terra' })
    const pill = resolveSlashPill(m, m.content)
    expect(pill).toEqual({ command: '/diagram', args: 'auth flow', modelDisplay: 'Standard · GPT-5.6 Terra' })
  })

  it('includes model provenance with tier only', () => {
    const m = msg({ slashCommand: '/clear', slashModelAlias: 'Premium' })
    const pill = resolveSlashPill(m, m.content)
    expect(pill).toEqual({ command: '/clear', args: '', modelDisplay: 'Premium' })
  })

  it('includes model provenance with model only', () => {
    const m = msg({ slashCommand: '/diagram', slashArgs: 'x', slashModelEffective: 'Claude Opus' })
    const pill = resolveSlashPill(m, m.content)
    expect(pill).toEqual({ command: '/diagram', args: 'x', modelDisplay: 'Claude Opus' })
  })
})

describe('formatSlashModelDisplay', () => {
  it('formats raw tier and provider-qualified model identifiers', () => {
    expect(formatSlashModelDisplay('standard', 'dci-marketing/gpt-5.6-terra')).toBe('Standard · GPT 5.6 Terra')
  })

  it('returns "tier · model" when both present', () => {
    expect(formatSlashModelDisplay('Standard', 'GPT-5.6 Terra')).toBe('Standard · GPT-5.6 Terra')
  })

  it('returns tier alone when model missing', () => {
    expect(formatSlashModelDisplay('Premium', undefined)).toBe('Premium')
  })

  it('returns model alone when tier missing', () => {
    expect(formatSlashModelDisplay(undefined, 'Claude Opus')).toBe('Claude Opus')
  })

  it('returns null when neither present', () => {
    expect(formatSlashModelDisplay(undefined, undefined)).toBeNull()
  })

  it('returns null for empty strings', () => {
    expect(formatSlashModelDisplay('', '')).toBeNull()
  })
})

describe('resolveSlashPill — fallback content parse (no metadata)', () => {
  it('pills a message whose content starts with /x and has no slashCommand', () => {
    const m = msg({ content: '/export markdown json' })
    const pill = resolveSlashPill(m, m.content)
    expect(pill).toEqual({ command: '/export', args: 'markdown json', modelDisplay: null })
  })

  it('renders model provenance stamped onto an optimistic row before slash metadata', () => {
    const m = msg({
      content: '/align',
      slashModelAlias: 'standard',
      slashModelEffective: 'gpt-5.6-terra',
    })
    const pill = resolveSlashPill(m, m.content)
    expect(pill).toEqual({ command: '/align', args: '', modelDisplay: 'Standard · GPT 5.6 Terra' })
  })

  it('does NOT pill plain text', () => {
    const m = msg({ content: 'hello world' })
    expect(resolveSlashPill(m, m.content)).toBeNull()
  })

  it('does NOT pill content that does not start with a slash', () => {
    expect(parseSlashCommand('hello /not-a-command')).toBeNull()
  })

  it('does NOT pill a non-identifier leading segment (e.g. a numeric path)', () => {
    // The fallback requires the command to start with a letter, so `/123abc`
    // is not treated as a slash command.
    expect(parseSlashCommand('/123/nope')).toBeNull()
  })
})
