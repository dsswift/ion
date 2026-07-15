import { describe, it, expect } from 'vitest'
import { conversationTailFingerprint, FINGERPRINT_TAIL_WINDOW, type FingerprintMessage } from '../conversation-fingerprint'

function m(id: string, role: string, content: string, toolStatus?: string): FingerprintMessage {
  return { id, role, content, toolStatus }
}

describe('conversationTailFingerprint', () => {
  it('is stable for identical input', () => {
    const msgs = [m('a', 'user', 'hi'), m('b', 'assistant', 'hello there')]
    expect(conversationTailFingerprint(msgs)).toBe(conversationTailFingerprint(msgs))
  })

  it('changes when an assistant message content grows (appended text)', () => {
    const before = [m('a', 'user', 'hi'), m('b', 'assistant', 'one')]
    const after = [m('a', 'user', 'hi'), m('b', 'assistant', 'one two three')]
    expect(conversationTailFingerprint(before)).not.toBe(conversationTailFingerprint(after))
  })

  it('changes when a tool flips running -> completed (lost tool_end)', () => {
    const running = [m('t1', 'tool', 'partial', 'running')]
    const completed = [m('t1', 'tool', 'partial', 'completed')]
    expect(conversationTailFingerprint(running)).not.toBe(conversationTailFingerprint(completed))
  })

  it('does NOT change when a tool result content is truncated (status unchanged)', () => {
    // The desktop snapshot sees full content; the history page truncates >2KB.
    // Tool rows are fingerprinted by STATUS ONLY, so the two contents must
    // produce the same fingerprint or iOS would reload-loop on big tool results.
    const full = [m('t1', 'tool', 'x'.repeat(5000), 'completed')]
    const truncated = [m('t1', 'tool', 'x'.repeat(2048) + '\n... [truncated]', 'completed')]
    expect(conversationTailFingerprint(full)).toBe(conversationTailFingerprint(truncated))
  })

  it('changes when a new message is appended', () => {
    const before = [m('a', 'user', 'hi')]
    const after = [m('a', 'user', 'hi'), m('b', 'assistant', 'reply')]
    expect(conversationTailFingerprint(before)).not.toBe(conversationTailFingerprint(after))
  })

  it('PAGINATION-SAFE: same tail, different total length → SAME fingerprint (no false heal)', () => {
    // Regression for the reload-flash bug: iOS holds a paginated PAGE while the
    // desktop holds the FULL list. Both lists share the same final messages, so
    // their last-TAIL_WINDOW tails are identical and must fingerprint
    // IDENTICALLY — otherwise the iOS heal reloads on every snapshot. The
    // fingerprint carries NO total-count term precisely so this holds. (iOS's
    // page is PAGE_SIZE >> TAIL_WINDOW, so it always holds the full tail.)
    const sharedTail: FingerprintMessage[] = []
    for (let i = 0; i < FINGERPRINT_TAIL_WINDOW; i++) sharedTail.push(m(`tail-${i}`, 'assistant', `t ${i}`))

    // iOS page: 50 messages ending in the shared tail.
    const page: FingerprintMessage[] = []
    for (let i = 0; i < 40; i++) page.push(m(`page-${i}`, 'assistant', `p ${i}`))
    page.push(...sharedTail)

    // Desktop full: 500 messages ending in the same shared tail.
    const full: FingerprintMessage[] = []
    for (let i = 0; i < 490; i++) full.push(m(`old-${i}`, 'assistant', `old ${i}`))
    full.push(...sharedTail)

    expect(conversationTailFingerprint(page)).toBe(conversationTailFingerprint(full))
  })

  it('uses UTF-8 byte length, not UTF-16 code unit count', () => {
    // "é" is 1 UTF-16 unit but 2 UTF-8 bytes; "😀" is 2 UTF-16 units but 4 UTF-8 bytes.
    const ascii = [m('a', 'assistant', 'ab')] // 2 bytes
    const accent = [m('a', 'assistant', 'é')] // 2 bytes, 1 UTF-16 unit
    expect(conversationTailFingerprint(ascii)).toBe(conversationTailFingerprint(accent))
    const emoji = [m('a', 'assistant', '😀')] // 4 bytes
    expect(conversationTailFingerprint(ascii)).not.toBe(conversationTailFingerprint(emoji))
  })

  it('only spans the last TAIL_WINDOW messages', () => {
    const many: FingerprintMessage[] = []
    for (let i = 0; i < FINGERPRINT_TAIL_WINDOW + 5; i++) many.push(m(`id${i}`, 'assistant', `c${i}`))
    const changedHead = [...many]
    changedHead[0] = m('id0', 'assistant', 'COMPLETELY DIFFERENT')
    expect(conversationTailFingerprint(many)).toBe(conversationTailFingerprint(changedHead))
  })

  // GOLDEN parity fixture: the exact string the desktop produces for a known
  // input. The iOS ConversationStalenessReconcileTests pins the SAME string
  // for the SAME input, so a future edit to either side that breaks byte
  // parity fails one of the two tests.
  it('produces the pinned golden string (cross-platform parity anchor)', () => {
    const msgs = [
      m('u1', 'user', 'hello'),          // 5 bytes
      m('a1', 'assistant', 'hi there'),  // 8 bytes
      m('t1', 'tool', 'whatever', 'running'),
    ]
    expect(conversationTailFingerprint(msgs)).toBe('u1:5,a1:8,t1:tr')
  })

  // ── v2: persisted-role filter + toolId keying ──────────────────────────────

  it('excludes client-local roles (thinking / system / harness) before windowing', () => {
    // One side synthesizes thinking rows and inserts live system dividers
    // with local ids the other side never shares; the fingerprint must be
    // identical with and without them or the heal loops forever.
    const persisted = [
      m('u1', 'user', 'hello'),
      m('a1', 'assistant', 'hi there'),
    ]
    const withLocal: FingerprintMessage[] = [
      persisted[0],
      m('think-uuid', 'thinking', 'reasoning...'),
      m('sys-uuid', 'system', '── Plan created ──'),
      persisted[1],
      m('harness-1', 'harness', 'Session bootstrapped'),
    ]
    expect(conversationTailFingerprint(withLocal)).toBe(conversationTailFingerprint(persisted))
  })

  it('keys tool rows by toolId so live and reloaded rows agree', () => {
    // Live tool row keyed by toolId; a history reload of the same tool may
    // carry a different row id but the same toolId — tokens must match.
    const live: FingerprintMessage[] = [
      { id: 'toolu_9', role: 'tool', content: 'x', toolStatus: 'completed', toolId: 'toolu_9' },
    ]
    const reloaded: FingerprintMessage[] = [
      { id: 'e42:1', role: 'tool', content: 'x (truncated differently)', toolStatus: 'completed', toolId: 'toolu_9' },
    ]
    expect(conversationTailFingerprint(live)).toBe(conversationTailFingerprint(reloaded))
    expect(conversationTailFingerprint(live)).toBe('toolu_9:tc')
  })

  it('post-heal iOS page and desktop full list produce equal fingerprints', () => {
    // Desktop holds the full list including client-local rows; iOS holds a
    // heal page of persisted rows (canonical ids). Same tail → same string.
    const desktopFull: FingerprintMessage[] = [
      m('e01', 'user', 'old turn'),
      m('sys-local', 'system', '── Steer applied ──'),
      m('e02', 'assistant', 'old reply'),
      m('e03', 'user', 'do the thing'),
      m('think-local', 'thinking', 'hmm'),
      m('e04', 'assistant', 'done'),
      { id: 'toolu_1', role: 'tool', content: 'full tool output '.repeat(500), toolStatus: 'completed', toolId: 'toolu_1' },
    ]
    const iosPage: FingerprintMessage[] = [
      m('e01', 'user', 'old turn'),
      m('e02', 'assistant', 'old reply'),
      m('e03', 'user', 'do the thing'),
      m('e04', 'assistant', 'done'),
      { id: 'e04:1', role: 'tool', content: 'truncated…', toolStatus: 'completed', toolId: 'toolu_1' },
    ]
    expect(conversationTailFingerprint(desktopFull)).toBe(conversationTailFingerprint(iosPage))
  })
})
