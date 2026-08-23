// @vitest-environment jsdom
/**
 * ToolImagesStrip — regression test for the #224 render-path fix, plus the
 * one-gallery-per-group contract.
 *
 * The #224 bug: tool-generated images attach to `role: 'tool'` messages, which
 * render only inside ToolGroup / AgentTurnGroup — both collapse their tool
 * panel by default, so ToolRow (which used to render the images) never mounted
 * and the images never painted. The fix hoists tool images to this always-
 * rendered strip, decoupled from the collapse state.
 *
 * The follow-on bug: the strip rendered one image list PER tool row, so a group
 * of 21 image-returning tools produced 21 stacked lists and thousands of pixels
 * of transcript. Every row's images now flatten into ONE ImageGallery.
 *
 * Revert contract:
 *   - Rendering images from ToolRow again (behind the collapse) makes "renders
 *     an <img> per tool image regardless of collapse" fail.
 *   - Going back to per-row galleries makes "flattens every row into one
 *     gallery" fail (it would find one rail per row).
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
  rTrace: vi.fn(),
  rDebug: vi.fn(),
  rInfo: vi.fn(),
  rWarn: vi.fn(),
  rError: vi.fn(),
}))
vi.mock('../../git/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
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

  it('flattens every row into one gallery, not one per row', async () => {
    const tools = [toolMsg('t1', ['/c/a.png', '/c/b.png']), toolMsg('t2', ['/c/c.png'])]
    const { container, unmount } = await render(tools)
    expect(container.querySelectorAll('[data-testid="image-gallery-rail"]')).toHaveLength(1)
    unmount()
  })

  it('keeps duplicate paths from different tools as distinct entries', async () => {
    // Two tools returning the same path is two deliverables, not one. Keys are
    // scoped by tool id so React does not collapse them into a single tile.
    const tools = [toolMsg('t1', ['/c/same.png']), toolMsg('t2', ['/c/same.png'])]
    const { container, unmount } = await render(tools)
    expect(container.querySelectorAll('img')).toHaveLength(2)
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
