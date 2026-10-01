// @vitest-environment jsdom
/**
 * conv-image-restore-e2e — end-to-end verification of the #224 image-restore
 * pipeline against a full conversation.
 *
 * It uses two fixtures with the shape of a restored conversation:
 *
 *   - image-restore-engine-history.json — what the engine returns for
 *     load_session_history. 71 messages, 7 tool rows carrying 20 image
 *     attachments.
 *   - image-restore-cached-messages.json — the persisted desktop cache for the
 *     same tab.
 *
 * The test drives the real pipeline in order:
 *   1. mergeHistoryAttachments (the reconcile merge) folds engine-history
 *      attachments onto the cached messages by toolId.
 *   2. The merged Message[] is rendered through the real Transcript component
 *      in both views (unifiedTurnView true and false) with the real ToolRow /
 *      AgentTurnGroup / InlineMessageImages tree.
 *   3. The test asserts on the rendered <img> elements — the final user-visible
 *      artifact — not on intermediate store state.
 *
 * If the images do not reach the DOM, this test fails, and the failure
 * localizes the drop to the render path rather than the data path.
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Message, SessionLoadMessage } from '@ion/shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── Fixtures ──

const FIXTURE_DIR = join(__dirname, 'fixtures')
const CACHED_MESSAGES = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'image-restore-cached-messages.json'), 'utf8'),
) as Array<Record<string, unknown>>
const ENGINE_HISTORY = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'image-restore-engine-history.json'), 'utf8'),
) as SessionLoadMessage[]

// The desktop assigns a fresh renderer id to every restored message
// (buildPopulatedInstance maps m -> { id: crypto.randomUUID(), ... }). Model
// that here so the render keys are unique, mirroring the real restore.
function toRendererMessages(cached: Array<Record<string, unknown>>): Message[] {
  return cached.map((m, i) => ({
    id: `restored-${i}`,
    role: m.role as Message['role'],
    content: (m.content as string) || '',
    toolName: m.toolName as string | undefined,
    toolId: m.toolId as string | undefined,
    toolInput: m.toolInput as string | undefined,
    toolStatus: m.toolStatus as Message['toolStatus'],
    timestamp: (m.timestamp as number) ?? i,
    attachments: m.attachments as Message['attachments'],
    ...(m.role === 'assistant' ? { sealed: true } : {}),
  }))
}

// ── Mocks ──

// The default view setting.
let UNIFIED_TURN_VIEW = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      agentPanelDefaultOpen: false,
      unifiedTurnView: UNIFIED_TURN_VIEW,
      expandToolResults: false,
    }),
}))

vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ dispatchActivity: {}, tabs: [], activeTabId: null }),
}))

vi.mock('../../AgentPanel', () => ({
  AgentPanel: () => React.createElement('div', { 'data-testid': 'agent-panel' }),
}))

// window.ion.readImageDataUrl is what InlineImage -> useImageDataUrl calls to
// turn an on-disk path into a data URL. Return a stub data URL synchronously so
// a rendered InlineImage produces an <img> (not the filename fallback tile).
const readImageDataUrl = vi.fn(async (path: string) => ({
  dataUrl: `data:image/png;base64,STUB_FOR_${path.split('/').pop()}`,
}))

beforeEach(() => {
  ;(globalThis as unknown as { window: Window }).window = globalThis as unknown as Window
  ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = installFakeWire({
    readImageDataUrl,
    openExternal: vi.fn(),
    revealInFinder: vi.fn(),
  })
})

import { mergeHistoryAttachments } from '@ion/server/hooks/useTabRestoration-images'
import { Transcript } from '../../components/conversation/Transcript'
import { deriveMessageImages } from '../../components/conversation/InlineMessageImages'
import { groupMessages as _groupMessages } from '@ion/server/conversation/tool-helpers'
import { installFakeWire } from '../../host/__tests__/fake-wire'

async function renderTranscript(messages: Message[]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      React.createElement(Transcript, {
        messages,
        unifiedTurnView: UNIFIED_TURN_VIEW,
        isRunning: false,
      }),
    )
  })
  // Flush the useImageDataUrl effect + its resolved promise so <img> mounts.
  await act(async () => { await Promise.resolve() })
  return {
    container,
    unmount() {
      act(() => { root.unmount() })
      document.body.removeChild(container)
    },
  }
}

describe('conversation image restore — end to end', () => {
  it('fixture sanity: engine history carries 20 image attachments on 7 tool rows', () => {
    const rows = ENGINE_HISTORY.filter((m) => (m.attachments?.length ?? 0) > 0)
    const total = rows.reduce((n, m) => n + (m.attachments?.length ?? 0), 0)
    expect(rows).toHaveLength(7)
    expect(total).toBe(20)
    // Every attachment carries the shape deriveMessageImages needs.
    for (const r of rows) {
      for (const a of r.attachments ?? []) {
        expect((a as { type: string }).type).toBe('image')
        expect((a as { path?: string }).path).toBeTruthy()
      }
    }
  })

  it('reconcile merge keeps 20 attachments on the restored messages (data path)', () => {
    // Start from a copy of the cache with attachments STRIPPED, to model the
    // historical 0-attachment cache the reconciler was built to heal.
    const stripped = toRendererMessages(CACHED_MESSAGES).map((m) => ({ ...m, attachments: undefined }))
    const merged = mergeHistoryAttachments(stripped, ENGINE_HISTORY)
    const total = merged.reduce((n, m) => n + (m.attachments?.length ?? 0), 0)
    expect(total).toBe(20)

    // deriveMessageImages (the renderer's predicate) must see all 20.
    const derived = merged.reduce(
      (n, m) => n + deriveMessageImages(m.content || '', m.attachments).length,
      0,
    )
    expect(derived).toBe(20)
  })

  it('renders the 20 restored images to the DOM in unified view (unifiedTurnView: true)', async () => {
    UNIFIED_TURN_VIEW = true
    // The cache already carries the attachments (reconcile persisted them);
    // render exactly what the store holds after restore.
    const messages = toRendererMessages(CACHED_MESSAGES)
    const { container, unmount } = await renderTranscript(messages)
    const imgs = container.querySelectorAll('img')
    unmount()
    // The final user-visible artifact: an <img> per restored image.
    expect(imgs.length).toBe(20)
  })

  it('renders the 20 restored images to the DOM in legacy view (unifiedTurnView: false)', async () => {
    UNIFIED_TURN_VIEW = false
    const messages = toRendererMessages(CACHED_MESSAGES)
    const { container, unmount } = await renderTranscript(messages)
    const imgs = container.querySelectorAll('img')
    unmount()
    expect(imgs.length).toBe(20)
  })
})
