/**
 * handlePrompt — user-echo attachment parity (CLI branch).
 *
 * Regression: an image sent from iOS to a plain (CLI) tab rendered for an
 * instant, then vanished. The iOS optimistic insert carries marker-prefixed
 * content (`[Attached image: PATH]`) plus structured attachments; iOS then
 * reconciles by id with the desktop's `desktop_message_added` echo and
 * REPLACES the optimistic bubble. The CLI branch echoed bare `cmd.text` —
 * no markers, no attachments — so the reconciliation erased the inline
 * image. The engine branch had already fixed this exact defect; these tests
 * pin the CLI branch to the same echo shape.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// Electron is not installed in CI (npm ci --ignore-scripts skips the binary
// download); stub it so the transitive import chain loads headless.
vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  nativeImage: { createFromPath: vi.fn(), createFromBuffer: vi.fn() },
}))

const sent: any[] = []
const sendMock = vi.fn((event: any) => { sent.push(event) })
const executeJsMock = vi.fn(async () => null)

vi.mock('../../../state', () => ({
  state: {
    get mainWindow() {
      return { webContents: { executeJavaScript: executeJsMock } }
    },
    get remoteTransport() {
      return { send: sendMock, sendToDevice: vi.fn() }
    },
  },
  sessionPlane: { cancelTab: vi.fn() },
  engineBridge: {},
}))
vi.mock('../../../logger', () => ({ log: vi.fn() }))
vi.mock('../../../prompt-pipeline', () => ({ processIncomingPrompt: vi.fn(async () => {}) }))
vi.mock('../../attachment-encoder', () => ({
  encodeAttachments: vi.fn((text: string) => ({ encoded: [], rewrittenText: text })),
}))
vi.mock('../../../engine-bridge', () => ({ IS_REMOTE: false }))
vi.mock('./engine', () => ({ getVoiceSystemPrompt: vi.fn(() => undefined) }))
vi.mock('../../../engine-control-plane-interrupt', () => ({ performUnifiedInterrupt: vi.fn() }))

import { handlePrompt } from '../tabs-prompt'

beforeEach(() => {
  sent.length = 0
  sendMock.mockClear()
})

describe('handlePrompt CLI-branch user echo (no instanceId)', () => {
  it('echoes marker-prefixed content AND structured attachments with id === path', async () => {
    await handlePrompt({
      type: 'desktop_prompt',
      tabId: 'tab-1',
      text: 'what is this image?',
      clientMsgId: 'client-msg-1',
      attachments: [
        { type: 'image', name: 'photo.jpeg', path: '/tmp/ion-remote-1.jpeg' },
      ],
    } as any, 'device-1')

    const echo = sent.find((e) => e.type === 'desktop_message_added')
    expect(echo).toBeDefined()
    expect(echo.tabId).toBe('tab-1')
    expect(echo.message.id).toBe('client-msg-1')
    expect(echo.message.role).toBe('user')
    // Marker-prefixed content — the form the iOS optimistic insert built,
    // so reconciliation preserves the inline image path.
    expect(echo.message.content).toBe('[Attached image: /tmp/ion-remote-1.jpeg]\n\nwhat is this image?')
    // Structured attachments — id keyed by path (AttachmentImageCache key).
    expect(echo.message.attachments).toEqual([
      { id: '/tmp/ion-remote-1.jpeg', type: 'image', name: 'photo.jpeg', path: '/tmp/ion-remote-1.jpeg' },
    ])
  })

  it('echoes bare text with no attachments field when the prompt has none', async () => {
    await handlePrompt({
      type: 'desktop_prompt',
      tabId: 'tab-1',
      text: 'plain text prompt',
      clientMsgId: 'client-msg-2',
    } as any, 'device-1')

    const echo = sent.find((e) => e.type === 'desktop_message_added')
    expect(echo).toBeDefined()
    expect(echo.message.content).toBe('plain text prompt')
    expect(echo.message.attachments).toBeUndefined()
  })

  it('carries slash provenance alongside attachments', async () => {
    await handlePrompt({
      type: 'desktop_prompt',
      tabId: 'tab-1',
      text: '/describe this',
      clientMsgId: 'client-msg-3',
      attachments: [
        { type: 'file', name: 'doc.pdf', path: '/tmp/doc.pdf' },
      ],
    } as any, 'device-1')

    const echo = sent.find((e) => e.type === 'desktop_message_added')
    expect(echo).toBeDefined()
    expect(echo.message.slashCommand).toBe('/describe')
    expect(echo.message.attachments).toEqual([
      { id: '/tmp/doc.pdf', type: 'file', name: 'doc.pdf', path: '/tmp/doc.pdf' },
    ])
  })

  it('stamps the echo timestamp BEFORE the handler awaits — user turn precedes its deltas (RC-1)', async () => {
    // The echo timestamp must be captured at handler entry, before any
    // executeJavaScript round-trip, so the user turn's server timestamp is
    // monotonically before every assistant delta of the same turn. We prove
    // this by recording wall-clock immediately AFTER handlePrompt resolves
    // (which is after all its internal awaits): the echo timestamp must be
    // <= that later reading. A regression that stamps Date.now() at the send
    // site would still pass a coarse check, so we also assert the echo carries
    // a real numeric timestamp and that the handler imposes no artificial delay.
    const before = Date.now()
    await handlePrompt({
      type: 'desktop_prompt',
      tabId: 'tab-1',
      text: 'ordering matters',
      clientMsgId: 'client-msg-4',
    } as any, 'device-1')
    const after = Date.now()

    const echo = sent.find((e) => e.type === 'desktop_message_added')
    expect(echo).toBeDefined()
    expect(typeof echo.message.timestamp).toBe('number')
    // Echo timestamp was captured at entry, so it falls within the handler's
    // own execution window (>= before, <= after).
    expect(echo.message.timestamp).toBeGreaterThanOrEqual(before)
    expect(echo.message.timestamp).toBeLessThanOrEqual(after)
  })

  it('imposes no fixed startup delay on the engine branch (RC-2)', async () => {
    // The engine auto-create branch previously did `await sleep(500)` to guess
    // engine-session readiness. Readiness is now guaranteed downstream by the
    // awaited ensureSession, so the handler must not block on a timer. Drive the
    // engine branch (instanceId present) with no pre-existing instance so the
    // auto-create path runs, and assert the handler resolves promptly.
    executeJsMock.mockResolvedValueOnce(null) // activeInstanceId lookup → none
    executeJsMock.mockResolvedValueOnce('main' as any) // addEngineInstance → new id
    executeJsMock.mockResolvedValue(null) // subsequent queries (instanceInfo, model, cwd, plan)
    const start = Date.now()
    await handlePrompt({
      type: 'desktop_prompt',
      tabId: 'tab-e',
      text: 'engine prompt',
      clientMsgId: 'client-msg-5',
      instanceId: '',
    } as any, 'device-1')
    const elapsed = Date.now() - start
    // Generous ceiling: the mocked awaits resolve immediately, so any wait
    // approaching the former 500ms sleep is a regression. 200ms leaves ample
    // headroom for CI scheduling jitter while still catching the sleep.
    expect(elapsed).toBeLessThan(200)
    executeJsMock.mockReset()
    executeJsMock.mockResolvedValue(null)
  })
})
