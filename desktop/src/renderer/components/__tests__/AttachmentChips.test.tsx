// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileAttachment } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { useImageDataUrl } = vi.hoisted(() => ({ useImageDataUrl: vi.fn() }))
vi.mock('../ImageViewer', () => ({ useImageDataUrl }))
vi.mock('../../theme', () => ({
  useColors: () => ({
    surfacePrimary: 'white',
    surfaceSecondary: 'gray',
    textPrimary: 'black',
    textTertiary: 'slategray',
    dangerFg: 'red',
  }),
}))
vi.mock('../../hooks/useInteractiveState', () => ({
  useInteractiveState: () => ({ hover: false, pressed: false, handlers: {} }),
  interactiveBg: () => 'transparent',
}))
vi.mock('../../theme-tokens', () => ({ transitions: { base: '150ms ease' } }))
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, layout: _layout, initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>) => <div {...props}>{children}</div>,
  },
}))

import { AttachmentChips } from '../AttachmentChips'

const image: FileAttachment = {
  id: 'image-1',
  type: 'image',
  name: 'very-long-image-name.png',
  path: '/tmp/image.png',
  mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,IMAGE',
}
const file: FileAttachment = {
  id: 'file-1',
  type: 'file',
  name: 'notes.json',
  path: '/tmp/notes.json',
  mimeType: 'application/json',
}

function render(attachments: FileAttachment[], onRemove = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(<AttachmentChips attachments={attachments} onRemove={onRemove} />) })
  return {
    container,
    onRemove,
    unmount() {
      act(() => root.unmount())
      container.remove()
    },
  }
}

beforeEach(() => {
  useImageDataUrl.mockReset()
  useImageDataUrl.mockReturnValue('data:image/png;base64,DISK')
})

describe('AttachmentChips preview rail', () => {
  it('renders nothing for an empty queued attachment list', () => {
    const view = render([])
    try {
      expect(view.container.innerHTML).toBe('')
    } finally {
      view.unmount()
    }
  })

  it('renders a prominent, horizontally scrolling card for each attachment', () => {
    const view = render([image, file])
    try {
      const rail = view.container.querySelector('[data-testid="attachment-preview-rail"]') as HTMLElement
      expect(rail).toBeTruthy()
      expect(rail.style.overflowX).toBe('auto')
      const cards = view.container.querySelectorAll('[data-testid="attachment-card"]')
      expect(cards).toHaveLength(2)
      expect((cards[0] as HTMLElement).style.width).toBe('160px')
    } finally {
      view.unmount()
    }
  })

  it('uses attachment data immediately and contains complete image previews', () => {
    const view = render([image])
    try {
      expect(useImageDataUrl).toHaveBeenCalledWith(image.path, image.dataUrl)
      const preview = view.container.querySelector('[data-testid="attachment-image-preview"]') as HTMLImageElement
      expect(preview.src).toContain('DISK')
      expect(preview.style.objectFit).toBe('contain')
      expect(preview.style.height).toBe('104px')
    } finally {
      view.unmount()
    }
  })

  it('loads path-only images from disk and renders large file visuals for documents', () => {
    const pathOnlyImage = { ...image, id: 'image-2', dataUrl: undefined }
    const view = render([pathOnlyImage, file])
    try {
      expect(useImageDataUrl).toHaveBeenCalledWith(pathOnlyImage.path, undefined)
      expect(view.container.querySelector('[data-testid="attachment-image-preview"]')).toBeTruthy()
      const filePreview = view.container.querySelector('[data-testid="attachment-file-preview"]') as HTMLElement
      expect(filePreview).toBeTruthy()
      expect(filePreview.style.height).toBe('104px')
    } finally {
      view.unmount()
    }
  })

  it('keeps full names accessible and removes exact attachment ID', () => {
    const view = render([image])
    try {
      const name = view.container.querySelector(`[aria-label="${image.name}"]`)
      expect(name?.textContent).toBe(image.name)
      const remove = view.container.querySelector(`[aria-label="Remove ${image.name}"]`) as HTMLButtonElement
      expect(remove).toBeTruthy()
      act(() => remove.click())
      expect(view.onRemove).toHaveBeenCalledWith(image.id)
    } finally {
      view.unmount()
    }
  })
})
