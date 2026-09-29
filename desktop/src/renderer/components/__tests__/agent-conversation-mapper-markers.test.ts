// The dispatch preview renders the shared mapper's rows through the SAME
// groupMessages path as the main transcript. These tests pin that the mapper
// forwards marker rows in a shape that grouping classifies; the mapper's own
// id tests live beside it in packages/shared/src/transcript/__tests__.
import { describe, it, expect } from 'vitest'
import { mapConversationMessages } from '@ion/shared/transcript/agent-conversation-mapper'
import type { RawSessionMessage } from '@ion/shared/transcript/agent-conversation-mapper'
import { groupMessages } from '@ion/server/conversation/tool-helpers'
import {
  formatSteerAppliedDivider,
  formatPlanCreatedDivider,
  formatPlanUpdatedDivider,
  formatImplementDivider,
} from '@ion/shared/clear-divider'

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
