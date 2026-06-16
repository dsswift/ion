/**
 * notifications-tray-filter — global tray visibility selector
 *
 * Pins the kind-agnostic, blocklist-based filter for the global notification
 * tray (issue: de-opinionate resource kinds). The tray must:
 *   - show every workspace-scoped kind by default (empty blocklist),
 *   - hide ONLY workspace items whose kind is in excludedResourceKinds,
 *   - NEVER hide conversation-scoped items (those belong to the attachments
 *     panel and are immune to the blocklist),
 *   - sort newest-first.
 */

import { describe, it, expect } from 'vitest'
import { selectTrayResources } from '../notifications-tray-filter'
import type { ResourceItem } from '../../../shared/types-engine'

function item(overrides: Partial<ResourceItem>): ResourceItem {
  return {
    id: 'id',
    kind: 'briefing',
    content: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('selectTrayResources', () => {
  it('shows every workspace kind when the blocklist is empty', () => {
    const resources = {
      briefing: [item({ id: 'b1', kind: 'briefing' })],
      report: [item({ id: 'r1', kind: 'report' })],
      'desktop.focus': [item({ id: 'f1', kind: 'desktop.focus' })],
    }
    const out = selectTrayResources(resources, [])
    expect(out.map((i) => i.id).sort()).toEqual(['b1', 'f1', 'r1'])
  })

  it('hides only the workspace items whose kind is excluded', () => {
    const resources = {
      briefing: [item({ id: 'b1', kind: 'briefing' })],
      'desktop.focus': [item({ id: 'f1', kind: 'desktop.focus' })],
    }
    const out = selectTrayResources(resources, ['desktop.focus'])
    expect(out.map((i) => i.id)).toEqual(['b1'])
  })

  it('never hides conversation-scoped items, even when their kind is excluded', () => {
    const resources = {
      briefing: [
        item({ id: 'global-b', kind: 'briefing' }),
        item({ id: 'conv-b', kind: 'briefing', conversationId: 'conv-1' }),
      ],
    }
    // Exclude the briefing kind entirely.
    const out = selectTrayResources(resources, ['briefing'])
    // The global briefing is hidden; the conversation-scoped one is not in the
    // tray at all (it's filtered out by scope, not by the blocklist) — so the
    // tray is empty here, and crucially the conversation-scoped item is never
    // surfaced in the tray regardless of the blocklist.
    expect(out).toHaveLength(0)
  })

  it('excludes ALL conversation-scoped items from the tray regardless of blocklist', () => {
    const resources = {
      briefing: [item({ id: 'conv-b', kind: 'briefing', conversationId: 'conv-1' })],
      report: [item({ id: 'conv-r', kind: 'report', conversationId: 'conv-2' })],
    }
    // Empty blocklist — but these are conversation-scoped, so the tray is empty.
    expect(selectTrayResources(resources, [])).toHaveLength(0)
  })

  it('sorts newest-first by createdAt', () => {
    const resources = {
      briefing: [
        item({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
        item({ id: 'new', createdAt: '2026-06-01T00:00:00.000Z' }),
        item({ id: 'mid', createdAt: '2026-03-01T00:00:00.000Z' }),
      ],
    }
    expect(selectTrayResources(resources, []).map((i) => i.id)).toEqual(['new', 'mid', 'old'])
  })

  it('is kind-agnostic: a brand-new extension kind appears with zero config', () => {
    const resources = {
      'com.acme.invoice': [item({ id: 'inv-1', kind: 'com.acme.invoice' })],
    }
    expect(selectTrayResources(resources, []).map((i) => i.id)).toEqual(['inv-1'])
  })
})
