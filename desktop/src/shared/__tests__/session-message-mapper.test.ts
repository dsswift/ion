/**
 * Unit tests for the shared engine-history → client-Message mapper
 * (session-message-mapper.ts). Focus: the marker-row handling added when the
 * engine began replaying persisted compaction / plan / steer markers as
 * system-role SessionLoadMessage rows on historical reload.
 *
 * These tests pin the behavior mirrored from the live-session handlers:
 *   - compaction marker → system Message with buildCompactionMarkerContent text
 *   - plan marker       → system Message carrying planFilePath (created/updated)
 *   - steer marker      → system Message with formatSteerAppliedDivider text
 *   - non-marker row    → ordinary Message with role/tool/slash fields
 *   - no-op compaction  → dropped (null), matching the live compacting handler
 */

import { describe, it, expect } from 'vitest'
import type { SessionLoadMessage } from '../types'
import { mapSessionMessage, mapSessionHistory } from '../session-message-mapper'
import { COMPACTION_MARKER_PREFIX } from '../compaction-marker'

let counter = 0
const makeId = () => `id-${++counter}`

describe('mapSessionMessage — marker rows', () => {
  it('maps a compaction marker to a system Message with compaction content', () => {
    const row: SessionLoadMessage = {
      role: 'system',
      content: '[Compaction]',
      timestamp: 1000,
      markerKind: 'compaction',
      markerMessagesBefore: 40,
      markerMessagesAfter: 12,
      markerClearedBlocks: 3,
      markerStrategy: 'summarize',
      markerSummary: 'kept the key facts',
    }
    const msg = mapSessionMessage(row, makeId)
    expect(msg).not.toBeNull()
    expect(msg!.role).toBe('system')
    // Formatted by buildCompactionMarkerContent — carries the sentinel prefix,
    // the strategy, the N → M messages figure, and the summary body.
    expect(msg!.content.startsWith(COMPACTION_MARKER_PREFIX)).toBe(true)
    expect(msg!.content).toContain('40 → 12 messages')
    expect(msg!.content).toContain('3 blocks cleared')
    expect(msg!.content).toContain('kept the key facts')
    expect(msg!.timestamp).toBe(1000)
  })

  it('drops a no-op compaction marker (null), matching the live handler', () => {
    const row: SessionLoadMessage = {
      role: 'system',
      content: '[Compaction]',
      timestamp: 2000,
      markerKind: 'compaction',
      // No dropped messages, no cleared blocks, no summary → buildCompaction
      // MarkerContent returns null, so the mapper drops the row entirely.
      markerMessagesBefore: 10,
      markerMessagesAfter: 10,
      markerClearedBlocks: 0,
    }
    expect(mapSessionMessage(row, makeId)).toBeNull()
  })

  it('maps a micro-only compaction marker without an "N → N messages" figure', () => {
    const row: SessionLoadMessage = {
      role: 'system',
      content: '[Compaction]',
      timestamp: 2500,
      markerKind: 'compaction',
      markerMessagesBefore: 20,
      markerMessagesAfter: 20,
      markerClearedBlocks: 5,
      markerStrategy: 'micro',
      markerMicroOnly: true,
    }
    const msg = mapSessionMessage(row, makeId)
    expect(msg).not.toBeNull()
    expect(msg!.content).not.toContain('→')
    expect(msg!.content).toContain('5 blocks cleared')
  })

  it('maps a created plan marker to a system Message carrying planFilePath', () => {
    const row: SessionLoadMessage = {
      role: 'system',
      content: '──',
      timestamp: 3000,
      markerKind: 'plan',
      markerPlanOperation: 'created',
      markerPlanFilePath: '/test/plan.md',
      markerPlanSlug: 'plan',
    }
    const msg = mapSessionMessage(row, makeId)
    expect(msg).not.toBeNull()
    expect(msg!.role).toBe('system')
    expect(msg!.planFilePath).toBe('/test/plan.md')
    expect(msg!.content).toContain('Plan created')
    expect(msg!.content).toContain('plan')
  })

  it('maps an updated plan marker to the "Plan updated" divider', () => {
    const row: SessionLoadMessage = {
      role: 'system',
      content: '──',
      timestamp: 3500,
      markerKind: 'plan',
      markerPlanOperation: 'updated',
      markerPlanFilePath: '/test/other.md',
      markerPlanSlug: 'other',
    }
    const msg = mapSessionMessage(row, makeId)
    expect(msg).not.toBeNull()
    expect(msg!.content).toContain('Plan updated')
    expect(msg!.planFilePath).toBe('/test/other.md')
  })

  it('maps a steer marker to a system Message with steer content', () => {
    const row: SessionLoadMessage = {
      role: 'system',
      content: '──',
      timestamp: 4000,
      markerKind: 'steer',
      markerMessageLength: 42,
    }
    const msg = mapSessionMessage(row, makeId)
    expect(msg).not.toBeNull()
    expect(msg!.role).toBe('system')
    expect(msg!.content).toContain('Steer applied')
    expect(msg!.content).toContain('42 chars')
  })
})

describe('mapSessionMessage — ordinary rows', () => {
  it('maps a plain assistant message with content and timestamp', () => {
    const row: SessionLoadMessage = { role: 'assistant', content: 'hello', timestamp: 5000 }
    const msg = mapSessionMessage(row, makeId)
    expect(msg).not.toBeNull()
    expect(msg!.role).toBe('assistant')
    expect(msg!.content).toBe('hello')
    expect(msg!.planFilePath).toBeUndefined()
  })

  it('carries tool + slash provenance and marks completed tool rows', () => {
    const row: SessionLoadMessage = {
      role: 'tool',
      content: 'result',
      timestamp: 6000,
      toolName: 'Read',
      toolId: 'tool-1',
      toolInput: '{"file_path":"/a"}',
      slashCommand: 'read',
      slashArgs: '/a',
      slashSource: 'ion',
    }
    const msg = mapSessionMessage(row, makeId)!
    expect(msg.toolName).toBe('Read')
    expect(msg.toolStatus).toBe('completed')
    expect(msg.slashCommand).toBe('read')
    expect(msg.slashSource).toBe('ion')
  })

  it('carries engine-replayed image attachments on a reloaded tool row', () => {
    // The engine's flattenEntries replays a persisted tool-result image as a
    // SessionMessage.Attachments entry on the owning tool row (image support,
    // historical reload path). The mapper must forward attachments verbatim so
    // ToolRow/deriveMessageImages renders the image inline after reload, exactly
    // as the live image_content event path does. Without the forward, reloaded
    // engine-generated tool images are lost.
    const row: SessionLoadMessage = {
      role: 'tool',
      content: '[Image: screenshot]',
      timestamp: 7000,
      toolName: 'Screenshot',
      toolId: 'tool-shot',
      attachments: [
        {
          id: 'img:/home/u/.ion/conversations/c/images/abc.png',
          type: 'image',
          name: 'abc.png',
          path: '/home/u/.ion/conversations/c/images/abc.png',
          mimeType: 'image/png',
        },
      ],
    }
    const msg = mapSessionMessage(row, makeId)!
    expect(msg.attachments).toHaveLength(1)
    expect(msg.attachments![0].type).toBe('image')
    expect(msg.attachments![0].path).toBe('/home/u/.ion/conversations/c/images/abc.png')
  })
})

describe('mapSessionHistory', () => {
  it('filters internal rows and dropped no-op compactions, preserving order', () => {
    const history: SessionLoadMessage[] = [
      { role: 'user', content: 'q', timestamp: 1 },
      { role: 'assistant', content: 'a', timestamp: 2, internal: true },
      // no-op compaction → dropped
      { role: 'system', content: '[Compaction]', timestamp: 3, markerKind: 'compaction' },
      {
        role: 'system', content: '──', timestamp: 4, markerKind: 'plan',
        markerPlanOperation: 'created', markerPlanFilePath: '/p.md', markerPlanSlug: 'p',
      },
      { role: 'assistant', content: 'done', timestamp: 5 },
    ]
    const out = mapSessionHistory(history, makeId)
    expect(out.map((m) => m.role)).toEqual(['user', 'system', 'assistant'])
    expect(out[1].planFilePath).toBe('/p.md')
  })
})
