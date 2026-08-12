// Unit tests for agent-conversation-mapper.ts — stable per-message ID generation.
//
// These tests MUST fail on the old index-based code (`${convId.slice(0,8)}-${i}`)
// and pass on the new deterministic mapper. They exercise:
//   1. Idempotency: same input → same IDs on both calls (no random/index drift).
//   2. Tool ID derivation: tool rows use `tool-${toolId}`.
//   3. Collision suffix: two messages with the same role+timestamp get unique IDs
//      by appending `#1`, `#2`, … on repeats.
//   4. toolId is forwarded onto the Message object (required by reconcileActivity
//      tool-id dedup and stable tool-group React keys).
import { describe, it, expect } from 'vitest'
import { mapConversationMessages } from '../agent-conversation-mapper'
import type { RawSessionMessage } from '../agent-conversation-mapper'
import { groupMessages } from '../conversation/tool-helpers'
import {
  formatSteerAppliedDivider,
  formatPlanCreatedDivider,
  formatPlanUpdatedDivider,
  formatImplementDivider,
} from '../../../shared/clear-divider'

describe('mapConversationMessages — stable IDs', () => {
  it('produces identical IDs on two calls with the same input (idempotency)', () => {
    const raw: RawSessionMessage[] = [
      { role: 'user', content: 'hello', timestamp: 1000 },
      { role: 'assistant', content: 'hi', timestamp: 2000 },
      { role: 'tool', content: '', toolName: 'Read', toolId: 'toolu_01ABC', timestamp: 3000 },
    ]

    const first = mapConversationMessages(raw).map((m) => m.id)
    const second = mapConversationMessages(raw).map((m) => m.id)

    // Must be identical — would fail on old `${convId.slice(0,8)}-${i}` if convId
    // changed between calls, or on any index-based scheme applied inconsistently.
    expect(first).toEqual(second)
  })

  it('tool rows use tool-${toolId}, not an index-based id', () => {
    const raw: RawSessionMessage[] = [
      { role: 'user', content: 'do it', timestamp: 1000 },
      { role: 'tool', content: '', toolName: 'Bash', toolId: 'toolu_XYZ999', timestamp: 2000 },
    ]

    const msgs = mapConversationMessages(raw)
    const toolMsg = msgs.find((m) => m.role === 'tool')

    expect(toolMsg?.id).toBe('tool-toolu_XYZ999')
    // Must NOT match the old index pattern
    expect(toolMsg?.id).not.toMatch(/^[0-9a-f]+-\d+$/)
  })

  it('toolId is forwarded onto the mapped Message object', () => {
    const raw: RawSessionMessage[] = [
      { role: 'tool', content: 'output', toolName: 'Read', toolId: 'toolu_FORWARD', timestamp: 5000 },
    ]

    const msgs = mapConversationMessages(raw)
    expect(msgs[0].toolId).toBe('toolu_FORWARD')
  })

  it('non-tool rows use role-timestamp as base id', () => {
    const raw: RawSessionMessage[] = [
      { role: 'user', content: 'q', timestamp: 1234 },
      { role: 'assistant', content: 'a', timestamp: 5678 },
    ]

    const msgs = mapConversationMessages(raw)
    expect(msgs[0].id).toBe('user-1234')
    expect(msgs[1].id).toBe('assistant-5678')
  })

  it('collision suffix makes same-role/same-timestamp rows unique', () => {
    // Two assistant messages at the same millisecond (can happen during streaming
    // when timestamps are coarse). The first keeps the plain key; subsequent ones
    // get #1, #2, … suffixes.
    const raw: RawSessionMessage[] = [
      { role: 'assistant', content: 'part A', timestamp: 9000 },
      { role: 'assistant', content: 'part B', timestamp: 9000 },
      { role: 'assistant', content: 'part C', timestamp: 9000 },
    ]

    const msgs = mapConversationMessages(raw)
    expect(msgs[0].id).toBe('assistant-9000')
    expect(msgs[1].id).toBe('assistant-9000#1')
    expect(msgs[2].id).toBe('assistant-9000#2')

    // All IDs are unique
    const ids = msgs.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('collision suffix is stable across calls (idempotent)', () => {
    const raw: RawSessionMessage[] = [
      { role: 'user', content: 'a', timestamp: 100 },
      { role: 'user', content: 'b', timestamp: 100 },
    ]

    const first = mapConversationMessages(raw).map((m) => m.id)
    const second = mapConversationMessages(raw).map((m) => m.id)

    expect(first).toEqual(['user-100', 'user-100#1'])
    expect(second).toEqual(['user-100', 'user-100#1'])
  })

  it('appending a message at the tail does not change earlier ids', () => {
    const base: RawSessionMessage[] = [
      { role: 'user', content: 'q', timestamp: 1000 },
      { role: 'assistant', content: 'a', timestamp: 2000 },
    ]
    const extended: RawSessionMessage[] = [
      ...base,
      { role: 'tool', content: '', toolName: 'Bash', toolId: 'toolu_NEW', timestamp: 3000 },
    ]

    const baseMapped = mapConversationMessages(base)
    const extMapped = mapConversationMessages(extended)

    // IDs for the first two messages must be identical in both results
    expect(extMapped[0].id).toBe(baseMapped[0].id)
    expect(extMapped[1].id).toBe(baseMapped[1].id)
    // New tail message has the expected tool id
    expect(extMapped[2].id).toBe('tool-toolu_NEW')
  })

  it('empty input returns empty array', () => {
    expect(mapConversationMessages([])).toEqual([])
  })
})

// ─── Deliverable 3: full marker set in the dispatch preview ──────────────────
//
// The dispatch preview (AgentPanel → AgentDetailPanel) renders mapped messages
// through the SAME groupMessages/TranscriptRows path as the main transcript.
// For markers to render, the mapper must forward the marker rows the engine /
// persisted conversation carries — steer dividers, plan-lifecycle dividers, and
// compaction rows — with the fields groupMessages and SystemMessage rely on
// (role stays 'system', content prefix intact, planFilePath preserved for the
// clickable plan slug). The mapper previously dropped planFilePath and stamped
// toolStatus:'completed' on every row indiscriminately, so these tests fail on
// the old code and pass once the mapper preserves marker fields.
describe('mapConversationMessages — markers (steer / plan / compaction)', () => {
  it('emits a steer marker that groupMessages classifies as a system divider', () => {
    const raw: RawSessionMessage[] = [
      { role: 'user', content: 'go', timestamp: 1000 },
      { role: 'system', content: formatSteerAppliedDivider(new Date(0), 42), timestamp: 2000 },
      { role: 'assistant', content: 'ok', timestamp: 3000 },
    ]

    const msgs = mapConversationMessages(raw)
    const steer = msgs.find((m) => m.content.startsWith('── Steer applied'))
    // Role must remain 'system' — a steer divider mis-typed as anything else
    // would not reach the SystemMessage divider render path.
    expect(steer).toBeDefined()
    expect(steer?.role).toBe('system')
    // Marker rows are not tool rows: the mapper must not stamp a tool status
    // on them (the old mapper set toolStatus:'completed' on every row).
    expect(steer?.toolStatus).toBeUndefined()

    // And groupMessages must classify it as a standalone system row (divider),
    // not fold it into a tool group or drop it.
    const grouped = groupMessages(msgs, { includeUser: true })
    const systemItem = grouped.find(
      (g) => g.kind === 'system' && g.message.content.startsWith('── Steer applied'),
    )
    expect(systemItem).toBeDefined()
  })

  it('emits plan-created, plan-updated, and plan-implemented markers with planFilePath preserved', () => {
    const planPath = '/repo/.ion/plans/my-feature.md'
    const raw: RawSessionMessage[] = [
      { role: 'system', content: formatPlanCreatedDivider(new Date(0), 'my-feature'), timestamp: 1000, planFilePath: planPath },
      { role: 'assistant', content: 'writing', timestamp: 2000 },
      { role: 'system', content: formatPlanUpdatedDivider(new Date(0), 'my-feature'), timestamp: 3000, planFilePath: planPath },
      { role: 'system', content: formatImplementDivider(new Date(0), 'my-feature'), timestamp: 4000, planFilePath: planPath },
    ]

    const msgs = mapConversationMessages(raw)

    const created = msgs.find((m) => m.content.startsWith('── Plan created'))
    const updated = msgs.find((m) => m.content.startsWith('── Plan updated'))
    const implemented = msgs.find((m) => m.content.startsWith('── Implementing plan'))

    for (const marker of [created, updated, implemented]) {
      expect(marker).toBeDefined()
      expect(marker?.role).toBe('system')
      // planFilePath must survive the mapping so the slug is clickable
      // (SystemMessage.hasPlanLink gates on message.planFilePath).
      expect(marker?.planFilePath).toBe(planPath)
    }

    // groupMessages surfaces each as a standalone system divider row.
    const grouped = groupMessages(msgs, { includeUser: true })
    const dividerContents = grouped
      .filter((g) => g.kind === 'system')
      .map((g) => g.message.content)
    expect(dividerContents.some((c) => c.startsWith('── Plan created'))).toBe(true)
    expect(dividerContents.some((c) => c.startsWith('── Plan updated'))).toBe(true)
    expect(dividerContents.some((c) => c.startsWith('── Implementing plan'))).toBe(true)
  })

  it('emits a compaction marker that groupMessages classifies as a compaction row', () => {
    const raw: RawSessionMessage[] = [
      { role: 'user', content: 'work', timestamp: 1000 },
      { role: 'system', content: '[Compaction] Summarized 12 messages', timestamp: 2000 },
      { role: 'assistant', content: 'continuing', timestamp: 3000 },
    ]

    const msgs = mapConversationMessages(raw)
    const compaction = msgs.find((m) => m.content.startsWith('[Compaction]'))
    expect(compaction).toBeDefined()
    expect(compaction?.role).toBe('system')
    // A compaction row is a system marker, not a tool row.
    expect(compaction?.toolStatus).toBeUndefined()

    const grouped = groupMessages(msgs, { includeUser: true })
    const compItem = grouped.find((g) => g.kind === 'compaction')
    expect(compItem).toBeDefined()
    expect(compItem?.kind === 'compaction' && compItem.message.content.startsWith('[Compaction]')).toBe(true)
  })
})
