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
})
