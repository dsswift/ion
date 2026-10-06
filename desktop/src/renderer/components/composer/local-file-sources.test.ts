// @vitest-environment jsdom
/**
 * The platform file picker resolves to the chosen files, or to nothing on
 * cancel, and a page without screen sharing reports no capture.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn() }))

import { canCaptureScreen, pickLocalFiles } from './local-file-sources'

describe('local file sources', () => {
  afterEach(() => vi.restoreAllMocks())

  it('resolves to the picked files', async () => {
    const file = new File(['hi'], 'a.txt')
    const opened: HTMLInputElement[] = []
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      opened.push(this)
      Object.defineProperty(this, 'files', { value: [file] })
      this.dispatchEvent(new Event('change'))
    })
    await expect(pickLocalFiles({ accept: 'image/*' })).resolves.toEqual([file])
    expect(opened).toHaveLength(1)
    expect(opened[0].type).toBe('file')
    expect(opened[0].accept).toBe('image/*')
    expect(opened[0].multiple).toBe(true)
    expect(opened[0].isConnected).toBe(false)
  })

  it('resolves to nothing when the operator cancels', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      this.dispatchEvent(new Event('cancel'))
    })
    await expect(pickLocalFiles()).resolves.toEqual([])
  })

  it('reports no capture where the page has no screen sharing', () => {
    expect(canCaptureScreen()).toBe(false)
  })
})
