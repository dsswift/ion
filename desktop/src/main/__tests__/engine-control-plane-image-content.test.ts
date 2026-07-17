/**
 * engine-control-plane-events — engine_image_content translation test
 *
 * Pins the #224 desktop root-cause fix: the main-process control plane MUST
 * translate the engine's `engine_image_content` wire event into the
 * `image_content` NormalizedEvent the renderer's event-slice-images
 * materializer consumes. Before the fix there was no switch arm for it, so the
 * event was dropped before reaching the renderer — desktop-side inline images
 * never rendered live and never persisted (iOS still got them via the generic
 * wire forwarder, which is why only the desktop was broken).
 *
 * Revert-test contract: deleting the `engine_image_content` arm from
 * engine-control-plane-events.ts turns these tests red — no `image_content`
 * NormalizedEvent is emitted.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  trace: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../session-meta', () => ({
  conversationExists: vi.fn(() => true),
}))

import { handleEngineEvent } from '../engine-control-plane-events'
import type { TabEntry, EventEmitterContext } from '../engine-control-plane-events'
import type { EngineEvent, NormalizedEvent } from '../../shared/types'

function makeTab(overrides: Partial<TabEntry> = {}): TabEntry {
  return {
    tabId: 'tab-001',
    status: 'running',
    activeRequestId: null,
    conversationId: 'conv-1',
    engineSessionStarted: true,
    lastActivityAt: Date.now(),
    promptCount: 0,
    promptCountSinceCheckpoint: 0,
    clearedSinceLastPrompt: false,
    resumedSavedConversation: false,
    permissionMode: 'auto',
    approvedTools: [],
    startedAt: Date.now() - 1000,
    toolCallCount: 0,
    sawPermissionRequest: false,
    lastSurfacedProposalSig: null,
    ...overrides,
  }
}

describe('engine_image_content → image_content NormalizedEvent', () => {
  let emitted: Array<[string, string, NormalizedEvent]>
  let ctx: EventEmitterContext

  beforeEach(() => {
    emitted = []
    ctx = {
      bridge: {} as any,
      emit: (eventName: string, ...args: unknown[]) => {
        if (eventName === 'event') emitted.push(['event', args[0] as string, args[1] as NormalizedEvent])
      },
      setStatus: vi.fn(),
      checkDrain: vi.fn(),
    }
  })

  it('translates a tool image (with toolId) to image_content carrying path/mediaType/source/toolId', () => {
    const event: EngineEvent = {
      type: 'engine_image_content',
      imagePath: '/Users/x/.ion/conversations/conv-1/images/abc.png',
      imageMediaType: 'image/png',
      imageSource: 'tool',
      imageToolId: 'toolu_123',
    }

    handleEngineEvent(ctx, 'tab-001', makeTab(), event)

    const img = emitted.find(([, , e]) => e.type === 'image_content')
    expect(img).toBeDefined()
    const payload = img![2] as Extract<NormalizedEvent, { type: 'image_content' }>
    expect(payload.path).toBe('/Users/x/.ion/conversations/conv-1/images/abc.png')
    expect(payload.mediaType).toBe('image/png')
    expect(payload.source).toBe('tool')
    expect(payload.toolId).toBe('toolu_123')
  })

  it('translates a provider image (no toolId) and omits the toolId field', () => {
    const event: EngineEvent = {
      type: 'engine_image_content',
      imagePath: '/Users/x/.ion/conversations/conv-1/images/def.jpg',
      imageMediaType: 'image/jpeg',
      imageSource: 'provider',
    }

    handleEngineEvent(ctx, 'tab-001', makeTab(), event)

    const img = emitted.find(([, , e]) => e.type === 'image_content')
    expect(img).toBeDefined()
    const payload = img![2] as Extract<NormalizedEvent, { type: 'image_content' }>
    expect(payload.path).toBe('/Users/x/.ion/conversations/conv-1/images/def.jpg')
    expect(payload.source).toBe('provider')
    expect('toolId' in payload).toBe(false)
  })
})
