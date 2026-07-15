// @vitest-environment jsdom
/**
 * InlineMessageImages-paste-restore.test.tsx
 *
 * Pins the Part 2 fallback fix: pasted/screenshot images whose on-disk path
 * no longer exists (pre-fix sessions wrote to tmpdir) render from the
 * persisted FileAttachment.dataUrl instead of showing the filename placeholder.
 *
 * Revert-test contract:
 *   - If deriveMessageImages stops surfacing dataUrl from FileAttachment,
 *     the "deriveMessageImages surfaces dataUrl" test fails.
 *   - If InlineImage stops passing initialDataUrl to useImageDataUrl,
 *     the "renders <img> from persisted dataUrl when file is missing" test fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))

// readImageDataUrl returns null — simulates a missing tmpdir file post-restart.
const readImageDataUrl = vi.fn(async (_path: string) => ({ dataUrl: null }))

beforeEach(() => {
  ;(globalThis as any).window = globalThis
  ;(globalThis as any).window.ion = { readImageDataUrl }
})

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { deriveMessageImages, InlineMessageImages } from '../InlineMessageImages'
import type { FileAttachment } from '../../../../shared/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeImageAttachment(overrides: Partial<FileAttachment> = {}): FileAttachment {
  return {
    id: 'att-1',
    type: 'image',
    name: 'pasted image 1.png',
    path: '/tmp/ion-paste-old.png',
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,STORED_DATA_URL',
    size: 100,
    ...overrides,
  }
}

async function renderComponent(jsx: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(jsx) })
  // Flush the useImageDataUrl effect + its resolved promise.
  await act(async () => { await Promise.resolve() })
  return {
    container,
    unmount() {
      act(() => { root.unmount() })
      document.body.removeChild(container)
    },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('deriveMessageImages', () => {
  it('surfaces dataUrl from FileAttachment.dataUrl', () => {
    const att = makeImageAttachment()
    const images = deriveMessageImages('', [att])
    expect(images).toHaveLength(1)
    expect(images[0].dataUrl).toBe('data:image/png;base64,STORED_DATA_URL')
  })

  it('returns undefined dataUrl for marker-derived entries (no attachment object)', () => {
    const images = deriveMessageImages('[Attached image: /some/path.png]', [])
    expect(images).toHaveLength(1)
    expect(images[0].dataUrl).toBeUndefined()
  })

  it('returns undefined dataUrl when attachment has no dataUrl', () => {
    const att = makeImageAttachment({ dataUrl: undefined })
    const images = deriveMessageImages('', [att])
    expect(images[0].dataUrl).toBeUndefined()
  })
})

describe('InlineMessageImages — paste restore from persisted dataUrl', () => {
  it('renders <img> from persisted dataUrl when file is missing (readImageDataUrl returns null)', async () => {
    const att = makeImageAttachment()
    const { container, unmount } = await renderComponent(
      <InlineMessageImages content="" attachments={[att]} />,
    )
    const imgs = container.querySelectorAll('img')
    unmount()
    // The <img> must render even though readImageDataUrl returned null.
    // It renders because InlineImage seeded useImageDataUrl with initialDataUrl.
    expect(imgs.length).toBe(1)
    expect(imgs[0].getAttribute('src')).toBe('data:image/png;base64,STORED_DATA_URL')
  })

  it('shows filename placeholder when no dataUrl and file is missing', async () => {
    // No dataUrl on the attachment AND readImageDataUrl returns null →
    // should show the text fallback, not an <img>.
    // Use a distinct path to avoid the module-level dataUrlCache populated
    // by the previous test (both tests run in the same module scope).
    const att = makeImageAttachment({ dataUrl: undefined, path: '/tmp/ion-paste-no-dataurl.png', id: 'att-no-dataurl' })
    const { container, unmount } = await renderComponent(
      <InlineMessageImages content="" attachments={[att]} />,
    )
    const imgs = container.querySelectorAll('img')
    unmount()
    expect(imgs.length).toBe(0)
  })
})
