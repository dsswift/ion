/**
 * log-correlation — a log line's IDs come from the line, not from ambient state.
 *
 * The defect this pins: the logger carried ONE module-level session context,
 * stamped whenever a tab ensured its engine session. The desktop restores many
 * tabs at launch, so the last tab to start relabelled every line the process
 * wrote afterwards. Filtering `~/.ion/desktop.jsonl` by `conversation_id` — the
 * documented recipe in docs/observability/log-schema.md — therefore returned a
 * neighbour's lines AND omitted real lines for the conversation under
 * investigation, with no way to tell which was which.
 *
 * Regression direction: resolving from any process-wide "current session"
 * instead of from the line's own subject turns the interleaving test red.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { correlate, setConversationResolver, _resetForTest } from '../log-correlation'

beforeEach(() => {
  _resetForTest()
})

describe('correlate', () => {
  it('omits both keys when the line names no subject', () => {
    const ids = correlate({ fields: { dir: '/Users/dev/src/ion' } })
    // Per the schema's empty-string rule the keys are ABSENT, never ''.
    expect('session_id' in ids).toBe(false)
    expect('conversation_id' in ids).toBe(false)
  })

  it('reads the subject from tab_id or key, which name the same thing', () => {
    expect(correlate({ fields: { tab_id: 'tab-a' } }).session_id).toBe('tab-a')
    expect(correlate({ fields: { key: 'tab-a' } }).session_id).toBe('tab-a')
  })

  it('keeps interleaved conversations apart', () => {
    setConversationResolver((key) => ({ 'tab-a': 'conv-a', 'tab-b': 'conv-b' })[key])

    // Interleaved exactly as a multi-tab desktop emits them. Each line must
    // resolve to ITS OWN conversation regardless of emission order.
    expect(correlate({ fields: { tab_id: 'tab-a' } }).conversation_id).toBe('conv-a')
    expect(correlate({ fields: { tab_id: 'tab-b' } }).conversation_id).toBe('conv-b')
    expect(correlate({ fields: { tab_id: 'tab-a' } }).conversation_id).toBe('conv-a')

    // A process-wide line belongs to no conversation and stays unstamped.
    expect('conversation_id' in correlate({ fields: {} })).toBe(false)
  })

  it('prefers an explicit conversation_id over the registry', () => {
    setConversationResolver(() => 'conv-from-registry')
    const ids = correlate({ fields: { tab_id: 'tab-a', conversation_id: 'conv-explicit' } })
    expect(ids.conversation_id).toBe('conv-explicit')
  })

  it('prefers an explicit session_id over the inferred subject', () => {
    expect(correlate({ fields: { session_id: 'sess-x', tab_id: 'tab-a' } }).session_id).toBe('sess-x')
  })

  it('treats placeholders and blanks as absent, never as an id', () => {
    // `ensure_engine_session` logs conversation_id:'none' when it has none.
    expect('conversation_id' in correlate({ fields: { conversation_id: 'none' } })).toBe(false)
    expect('conversation_id' in correlate({ fields: { conversation_id: '' } })).toBe(false)
    expect('session_id' in correlate({ fields: { tab_id: '   ' } })).toBe(false)
    expect('session_id' in correlate({ fields: { tab_id: 42 } })).toBe(false)
  })

  it('omits conversation_id when the subject is not a live session', () => {
    setConversationResolver(() => undefined)
    const ids = correlate({ fields: { tab_id: 'tab-unknown' } })
    expect(ids.session_id).toBe('tab-unknown')
    expect('conversation_id' in ids).toBe(false)
  })

  it('never lets a resolver fault break the line', () => {
    setConversationResolver(() => { throw new Error('registry exploded') })
    const ids = correlate({ fields: { tab_id: 'tab-a' } })
    // The line still carries what it knows for certain, and simply lacks the
    // optional field. Logging must not fail the operation it observes.
    expect(ids.session_id).toBe('tab-a')
    expect('conversation_id' in ids).toBe(false)
  })
})
