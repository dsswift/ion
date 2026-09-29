// @vitest-environment jsdom
/**
 * The attachments count is a READING, not a notification.
 *
 * It used to render as an accent-filled pill pinned to the corner of the
 * paperclip — the same shape the notifications tray uses for unread items. A
 * conversation that had picked up two files therefore looked like two things
 * waiting on the operator to go and deal with. The count is nothing of the
 * kind: it reports what the conversation already holds.
 *
 * So the count now sits inline in the chip's own muted colour, matching the
 * model / thinking / mode chips beside it. This test fails on the pre-fix
 * button, which carried `position: absolute` and an accent background on the
 * count element.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi } from 'vitest'
import type { ResourceItem } from '@ion/shared/types-engine'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Each colour token renders as its own name, so an assertion can tell the
// accent apart from the muted text colour in the serialized markup.
vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_t, key) => `token-${String(key)}` }),
}))
vi.mock('../../preferences', () => ({ usePreferencesStore: { getState: () => ({}) } }))
vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))
vi.mock('../../host/host-instance', () => ({ host: { capabilities: () => [], shell: {} } }))
vi.mock('../../lib/file-open-router', () => ({ surfaceRouter: () => null, contentRouter: () => null }))
vi.mock('../PopoverLayer', () => ({ usePopoverLayer: () => null }))
vi.mock('../PlanViewer', () => ({ PlanViewer: () => null }))
vi.mock('../ImageViewer', () => ({ ImageViewer: () => null }))
vi.mock('../ResourceViewer', () => ({ ResourceViewer: () => null }))
vi.mock('../StatusBarAttachmentsCharts', () => ({ ChartsSection: () => null }))

const STATE = {
  tabs: [{ id: 'tab-1', conversationId: 'conv-1', workingDirectory: '/w' }],
  activeTabId: 'tab-1',
  conversationPanes: new Map(),
  resources: {
    briefing: [
      { id: 'r1', kind: 'briefing', conversationId: 'conv-1' } as unknown as ResourceItem,
      { id: 'r2', kind: 'briefing', conversationId: 'conv-1' } as unknown as ResourceItem,
    ],
  },
  openFileInEditor: vi.fn(),
}

vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: typeof STATE) => unknown) => selector(STATE),
    { getState: () => STATE, setState: vi.fn(), subscribe: vi.fn() },
  ),
}))

import { AttachmentsButton } from '../StatusBarAttachmentsButton'

function renderButton(): string {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => { root.render(<AttachmentsButton />) })
    return container.innerHTML
  } finally {
    act(() => { root.unmount() })
  }
}

describe('attachments count', () => {
  it('reads as a count in the chip, not an accent notification badge', () => {
    const html = renderButton()
    const count = html.match(/<span[^>]*data-testid="composer-attachment-count"[^>]*>([^<]*)<\/span>/)

    expect(count?.[1]).toBe('2')
    // The whole badge treatment is gone: no corner pinning, no accent fill.
    expect(count?.[0]).not.toContain('absolute')
    expect(count?.[0]).not.toContain('token-accent')
    expect(html).not.toContain('position: relative')
  })
})
