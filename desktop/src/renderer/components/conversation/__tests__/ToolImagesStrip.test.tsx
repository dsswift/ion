// @vitest-environment jsdom
/**
 * ToolImagesStrip — regression test for the #224 render-path fix.
 *
 * The bug: tool-generated images attach to `role: 'tool'` messages, which
 * render only inside ToolGroup / AgentTurnGroup — both collapse their tool
 * panel by default, so ToolRow (which used to render the images) never mounted
 * and the images never painted. The fix hoists tool images to this always-
 * rendered strip, decoupled from the collapse state.
 *
 * Revert contract: rendering images from ToolRow again (behind the collapse)
 * would make "renders an <img> per tool image regardless of collapse" fail,
 * because the strip is what mounts them unconditionally.
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message } from '../../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))
vi.mock('../../../rendererLogger', () => ({
  rInfo: vi.fn(),
}))

const readImageDataUrl = vi.fn(async (path: string) => ({ dataUrl: `data:image/png;base64,STUB_${path.split('/').pop()}` }))

beforeEach(() => {
  ;(globalThis as unknown as { window: { ion: unknown } }).window = globalThis as unknown as { ion: unknown }
  ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = { readImageDataUrl, openExternal: vi.fn() }
})

import { ToolImagesStrip } from '../ToolImagesStrip'

function toolMsg(id: string, paths: string[]): Message {
  return {
    id,
    role: 'tool',
    content: '',
    toolName: 'Read',
    toolId: id,
    timestamp: 1,
    attachments: paths.map((p) => ({ id: `img:${p}`, type: 'image', name: p.split('/').pop()!, path: p, mimeType: 'image/png' })),
  }
}

async function render(tools: Message[]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(ToolImagesStrip, { tools })) })
  await act(async () => { await Promise.resolve() })
  return {
    container,
    unmount() { act(() => root.unmount()); document.body.removeChild(container) },
  }
}

describe('ToolImagesStrip', () => {
  it('renders an <img> per tool image, unconditionally (no collapse gate)', async () => {
    const tools = [toolMsg('t1', ['/c/a.png', '/c/b.png']), toolMsg('t2', ['/c/c.png'])]
    const { container, unmount } = await render(tools)
    expect(container.querySelectorAll('img')).toHaveLength(3)
    unmount()
  })

  it('renders nothing when no tool row has images', async () => {
    const bare: Message = { id: 't1', role: 'tool', content: 'ok', toolName: 'Read', toolId: 't1', timestamp: 1 }
    const { container, unmount } = await render([bare])
    expect(container.querySelectorAll('img')).toHaveLength(0)
    unmount()
  })

  it('does not produce false-positive images from [Attached image: PATH] patterns in tool result text', async () => {
    // Bash tool output can contain the marker string verbatim (e.g. test fixture
    // output, grep results, file content). Only real FileAttachment objects on
    // tool.attachments should produce images — content is never scanned.
    const bashOutput: Message = {
      id: 't1',
      role: 'tool',
      content: 'strips [Attached image: /some/path/photo.png] markers\n[Attached image: /path/a.png]',
      toolName: 'Bash',
      toolId: 't1',
      timestamp: 1,
      // No attachments — no real images were produced.
    }
    const { container, unmount } = await render([bashOutput])
    expect(container.querySelectorAll('img')).toHaveLength(0)
    unmount()
  })
})
