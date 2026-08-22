/**
 * event-wiring — engine_image_content wire projection
 *
 * Regression test for the iOS missing-image bug: the generic engine-event
 * forwarder shipped `engine_image_content` via blind spread
 * (`{...event, tabId, instanceId, type: 'desktop_image_content'}`). The raw
 * engine event carries image-prefixed field names (`imagePath`,
 * `imageMediaType`, `imageSource`, `imageToolId` — prefixed in engine_event.go
 * to avoid colliding with other variants' primitives), but the wire contract
 * (remote/protocol.ts `desktop_image_content`) declares `path` / `mediaType` /
 * `source` / `toolId`, and iOS's decoder requires `path` — the decode threw
 * "Key 'path' not found", the frame was dropped, and provider-generated images
 * never rendered on iOS (log-confirmed: the image-model run's revised-prompt
 * text arrived alone, reading like a bare echo of the user's message).
 *
 * The fix projects the event explicitly at the forward seam with exactly the
 * protocol's declared fields, mirroring the renderer-side mapping in
 * engine-control-plane-events.ts (`path: event.imagePath`).
 *
 * Harness mirrors event-wiring-tool-stalled.test.ts (same vi.hoisted mock
 * block, same captured `engineBridge.'event'` handler, same `sentOfType`
 * helper).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const {
  mockSend,
  mockState,
  mockPermDenialSet,
  mockLastStatusMap,
  mockLastMetaMap,
  capturedHandler,
  mockShouldStream,
} = vi.hoisted(() => {
  const mockSend = vi.fn()
  const mockState = {
    remoteTransport: { send: mockSend } as any,
    mainWindow: null,
  }
  const mockPermDenialSet = new Set<string>()
  const mockLastStatusMap = new Map<string, string>()
  const mockLastMetaMap = new Map<string, number>()
  const capturedHandler = { fn: null as ((key: string, event: any) => void) | null }
  const mockShouldStream = vi.fn(() => true)
  return {
    mockSend,
    mockState,
    mockPermDenialSet,
    mockLastStatusMap,
    mockLastMetaMap,
    capturedHandler,
    mockShouldStream,
  }
})

vi.mock('../state', () => ({
  state: mockState,
  sessionPlane: { on: vi.fn(), emit: vi.fn(), notifyConversationCleared: vi.fn() },
  engineBridge: {
    on: vi.fn((event: string, handler: any) => {
      if (event === 'event') capturedHandler.fn = handler
    }),
    sendReconcileState: vi.fn(),
  },
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map(),
  extensionCommandRegistry: new Map(),
  forwardedEnginePermissionDenials: mockPermDenialSet,
  lastForwardedTabStatus: mockLastStatusMap,
  lastForwardedTabMeta: mockLastMetaMap,
}))

vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../settings-store', () => ({
  shouldStreamThinkingToRemote: mockShouldStream,
}))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))

import { wireEngineBridgeEvents } from '../event-wiring'

function emit(key: string, event: any): void {
  capturedHandler.fn!(key, event)
}

/** All forwarded wire messages whose type matches `wireType`. */
function sentOfType(wireType: string) {
  return mockSend.mock.calls.filter((c) => c[0]?.type === wireType)
}

// Compound key (`tabId:instanceId`) — the forwarder splits it for the
// tabId/instanceId ride-along.
const KEY = 'tab1:inst1'

describe('wireEngineBridgeEvents — engine_image_content projection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler.fn = null
    mockState.remoteTransport = { send: mockSend } as any
    mockPermDenialSet.clear()
    mockLastStatusMap.clear()
    mockLastMetaMap.clear()
    mockShouldStream.mockReturnValue(true)
    wireEngineBridgeEvents()
  })

  it('forwards a provider image with the contract field names iOS requires', () => {
    emit(KEY, {
      type: 'engine_image_content',
      imagePath: '/Users/x/.ion/conversations/abc/images/img1.png',
      imageMediaType: 'image/png',
      imageSource: 'provider',
      imageContentHash: 'abc123',
    })

    const sent = sentOfType('desktop_image_content')
    expect(sent).toHaveLength(1)
    expect(sent[0][0]).toEqual({
      type: 'desktop_image_content',
      tabId: 'tab1',
      instanceId: 'inst1',
      path: '/Users/x/.ion/conversations/abc/images/img1.png',
      mediaType: 'image/png',
      source: 'provider',
      contentHash: 'abc123',
    })
    // A provider image has no producing tool call — toolId must be OMITTED,
    // not present-as-empty (iOS distinguishes attach-to-tool-row vs
    // attach-to-assistant-row on toolId presence).
    expect('toolId' in sent[0][0]).toBe(false)
  })

  it('forwards a tool image with toolId carried through', () => {
    emit(KEY, {
      type: 'engine_image_content',
      imagePath: '/tmp/shot.png',
      imageMediaType: 'image/jpeg',
      imageSource: 'tool',
      imageToolId: 'tool-42',
    })

    const sent = sentOfType('desktop_image_content')
    expect(sent).toHaveLength(1)
    expect(sent[0][0]).toEqual({
      type: 'desktop_image_content',
      tabId: 'tab1',
      instanceId: 'inst1',
      path: '/tmp/shot.png',
      mediaType: 'image/jpeg',
      source: 'tool',
      toolId: 'tool-42',
    })
  })

  it('never forwards the raw engine field names or engine_ wire type', () => {
    emit(KEY, {
      type: 'engine_image_content',
      imagePath: '/tmp/img.png',
      imageMediaType: 'image/png',
      imageSource: 'provider',
      imageContentHash: 'abc123',
    })

    expect(sentOfType('engine_image_content')).toHaveLength(0)
    const sent = sentOfType('desktop_image_content')
    expect(sent).toHaveLength(1)
    // Explicit projection replaces the blind spread — the raw engine keys
    // must not ride along on the wire frame. Pre-fix the spread shipped
    // `imagePath` and omitted `path`, so the iOS decode threw
    // "Key 'path' not found" and the image frame was dropped.
    expect('imagePath' in sent[0][0]).toBe(false)
    expect('imageMediaType' in sent[0][0]).toBe(false)
    expect('imageSource' in sent[0][0]).toBe(false)
    expect(sent[0][0].path).toBe('/tmp/img.png')
  })
})
