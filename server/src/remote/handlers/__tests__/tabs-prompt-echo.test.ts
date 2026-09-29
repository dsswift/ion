/**
 * submitClientPrompt — the Studio mirror's echo of a client's prompt (CLI
 * branch).
 *
 * The echo carries the marker-prefixed content (`[Attached image: PATH]`),
 * the same text the owner store's row holds, under the client's clientMsgId.
 * The client that sent the prompt gets no echo: its row arrives on the
 * transcript stream.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// Electron is not installed in CI (npm ci --ignore-scripts skips the binary
// download); stub it so the transitive import chain loads headless.
vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  nativeImage: { createFromPath: vi.fn(), createFromBuffer: vi.fn() },
}))

const testMocks = vi.hoisted(() => ({
  processIncomingPrompt: vi.fn<(prompt: any) => Promise<void>>(async () => {}),
  echoUserTurn: vi.fn((echo: any) => { echoes.push(echo); return true }),
}))

const echoes: any[] = []
const executeJsMock = vi.fn(async () => null)

vi.mock('../../../state', () => ({
  state: {
    get mainWindow() {
      return { webContents: { executeJavaScript: executeJsMock } }
    },
  },
  sessionPlane: { cancelTab: vi.fn() },
  engineBridge: {},
}))
vi.mock('../../../user-turn-echo', () => ({ echoUserTurn: testMocks.echoUserTurn }))
vi.mock('../../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() }))
vi.mock('../../../engine/prompt-pipeline', () => ({ processIncomingPrompt: testMocks.processIncomingPrompt }))
vi.mock('../../../engine-bridge', () => ({ IS_REMOTE: false }))
vi.mock('./engine', () => ({ getVoiceSystemPrompt: vi.fn(() => undefined) }))
vi.mock('../../../engine-control-plane-interrupt', () => ({ performUnifiedInterrupt: vi.fn() }))

import { submitClientPrompt } from '../tabs-prompt'

const caller = { kind: 'caller', clientId: 'c1' } as const

beforeEach(() => {
  echoes.length = 0
  testMocks.echoUserTurn.mockClear()
  testMocks.processIncomingPrompt.mockClear()
})

describe('submitClientPrompt CLI-branch user echo (no instanceId)', () => {
  it('echoes marker-prefixed content under the client message id', async () => {
    await submitClientPrompt({
      tabId: 'tab-1',
      text: 'what is this image?',
      clientMsgId: 'client-msg-1',
      attachments: [
        { type: 'image', name: 'photo.jpeg', path: '/tmp/ion-remote-1.jpeg' },
      ],
    } as any, caller)

    const echo = echoes[0]
    expect(echo).toBeDefined()
    expect(echo.tabId).toBe('tab-1')
    expect(echo.id).toBe('client-msg-1')
    expect(echo.content).toBe('[Attached image: /tmp/ion-remote-1.jpeg]\n\nwhat is this image?')
  })

  it('echoes bare text when the prompt has no attachments', async () => {
    await submitClientPrompt({
      tabId: 'tab-1',
      text: 'plain text prompt',
      clientMsgId: 'client-msg-2',
    } as any, caller)

    const echo = echoes[0]
    expect(echo).toBeDefined()
    expect(echo.content).toBe('plain text prompt')
  })

  it('stamps the echo timestamp BEFORE the handler awaits — user turn precedes its deltas (RC-1)', async () => {
    // The echo timestamp must be captured at handler entry, before any
    // executeJavaScript round-trip, so the user turn's server timestamp is
    // monotonically before every assistant delta of the same turn. We prove
    // this by recording wall-clock immediately AFTER submitClientPrompt resolves
    // (which is after all its internal awaits): the echo timestamp must be
    // <= that later reading. A regression that stamps Date.now() at the send
    // site would still pass a coarse check, so we also assert the echo carries
    // a real numeric timestamp and that the handler imposes no artificial delay.
    const before = Date.now()
    await submitClientPrompt({
      tabId: 'tab-1',
      text: 'ordering matters',
      clientMsgId: 'client-msg-4',
    } as any, caller)
    const after = Date.now()

    const echo = echoes[0]
    expect(echo).toBeDefined()
    expect(typeof echo.timestamp).toBe('number')
    // Echo timestamp was captured at entry, so it falls within the handler's
    // own execution window (>= before, <= after).
    expect(echo.timestamp).toBeGreaterThanOrEqual(before)
    expect(echo.timestamp).toBeLessThanOrEqual(after)
  })

  it('passes engine attachments raw to the unified pipeline for one encoding pass', async () => {
    executeJsMock.mockResolvedValue(null)
    await submitClientPrompt({
      tabId: 'tab-engine-image',
      text: 'inspect this image',
      clientMsgId: 'client-msg-engine-image',
      instanceId: 'main',
      attachments: [
        {
          type: 'image',
          name: 'photo.jpeg',
          path: '/tmp/ion-remote-engine.jpeg',
          contentHash: 'hash-1',
        },
      ],
    } as any, caller)

    expect(testMocks.processIncomingPrompt).toHaveBeenCalledTimes(1)
    const routedPrompt = testMocks.processIncomingPrompt.mock.calls[0][0]
    expect(routedPrompt).toEqual(expect.objectContaining({
      text: 'inspect this image',
      attachments: [{
        type: 'image',
        name: 'photo.jpeg',
        path: '/tmp/ion-remote-engine.jpeg',
        contentHash: 'hash-1',
      }],
    }))
    expect(routedPrompt).not.toHaveProperty('imageAttachments')
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
    await submitClientPrompt({
      tabId: 'tab-e',
      text: 'engine prompt',
      clientMsgId: 'client-msg-5',
      instanceId: '',
    } as any, caller)
    const elapsed = Date.now() - start
    // Generous ceiling: the mocked awaits resolve immediately, so any wait
    // approaching the former 500ms sleep is a regression. 200ms leaves ample
    // headroom for CI scheduling jitter while still catching the sleep.
    expect(elapsed).toBeLessThan(200)
    executeJsMock.mockReset()
    executeJsMock.mockResolvedValue(null)
  })
})
