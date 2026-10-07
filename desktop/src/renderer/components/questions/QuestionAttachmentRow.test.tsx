// @vitest-environment jsdom
/**
 * The questions wizard's Attach image button stages through the same path as
 * the composer. A refused image is explained beside the button, because the
 * composer's notices are not on screen while a wizard is open.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const pickLocalFiles = vi.fn()
vi.mock('../composer/local-file-sources', () => ({ pickLocalFiles: (...a: unknown[]) => pickLocalFiles(...a) }))
vi.mock('../../stores/questions-store', () => ({ environmentOfWorkflow: () => 'box' }))
vi.mock('../../rendererLogger', () => ({ rWarn: vi.fn(), rError: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn() }))

const stageFilesFor = vi.fn()
vi.mock('../composer/attachment-staging', () => ({ stageFilesFor: (...a: unknown[]) => stageFilesFor(...a) }))

import { QuestionAttachmentRow } from './QuestionAttachmentRow'

const colors = new Proxy({}, { get: () => '#123456' }) as never

let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
const onChange = vi.fn()

async function pick(): Promise<void> {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(<QuestionAttachmentRow workflow={{ workflowId: 'w', sessionKey: 'tab-1' }} draft={{} as never} onChange={onChange} colors={colors} />) })
  await act(async () => { (container.querySelector('button') as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks() })

describe('QuestionAttachmentRow', () => {
  it('shows why an image was refused, beside the button, and attaches nothing', async () => {
    pickLocalFiles.mockResolvedValue([new File(['x'], 'big.jpg')])
    stageFilesFor.mockImplementation(async (_files: File[], _source: string, _target: unknown, onRefused: (m: string, f: File) => void) => {
      onRefused('big.jpg is too large to attach (40 MB; the limit is 25 MB).', _files[0])
      return []
    })
    await pick()

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('big.jpg is too large to attach (40 MB; the limit is 25 MB).')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows nothing and attaches the image when it was staged', async () => {
    pickLocalFiles.mockResolvedValue([new File(['x'], 'ok.jpg')])
    stageFilesFor.mockResolvedValue([{ id: 'a', type: 'image', name: 'ok.jpg', path: '/data/ok.jpg' }])
    await pick()

    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ attachments: [{ path: '/data/ok.jpg', name: 'ok.jpg' }] }))
  })
})
