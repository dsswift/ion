// @vitest-environment jsdom
/**
 * Composer intake: a drop stages attachments (by path on Electron, by upload
 * when the host has no path), an oversized paste folds into a text attachment
 * and leaves the editor alone, and the raw-paste chord bypasses the fold.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const addAttachments = vi.fn()
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ activeTabId: 'tab-1', addAttachments }) },
}))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rError: vi.fn(), rInfo: vi.fn() }))
let tabEnvironment = 'local'
vi.mock('../../studio/connection/tab-environment', () => ({ environmentOfTab: () => tabEnvironment, withTargetEnvironment: <T,>(_id: string, fn: () => T): T => fn() }))

let pathFor: (file: File) => string = () => ''
let caps: string[] = []
const attachFileByPath = vi.fn(async (_tabId: string, path: string) => ({ id: `p:${path}`, type: 'file' as const, name: 'a.txt', path }))
const saveAttachmentData = vi.fn(async (_tabId: string, name: string, _base64: string) => ({ id: `u:${name}`, type: 'file' as const, name, path: `/data/${name}` }))
vi.mock('../../host/host-instance', () => ({
  host: { capabilities: () => caps, shell: {
    getPathForFile: (file: File) => pathFor(file),
    attachFileByPath: (tabId: string, path: string) => attachFileByPath(tabId, path),
    saveAttachmentData: (tabId: string, name: string, base64: string) => saveAttachmentData(tabId, name, base64),
  } },
}))

import { useComposerIntake, type ComposerIntake } from './useComposerIntake'
import { useComposerDragStore } from './composer-drag-store'
import { LARGE_PASTE_BYTES, decideTextPaste, isRawPasteChord } from './composer-intake'

let intake: ComposerIntake
function Probe(): null { intake = useComposerIntake(); return null }

function dragEvent(type: string, files: File[]): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files } })
  return event
}
function pasteEvent(text: string, files: File[] = []): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: {
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    getData: () => text,
  } })
  return event
}
const settle = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }

describe('composer intake rules', () => {
  it('folds only text past the threshold, and never a raw paste', () => {
    expect(decideTextPaste('x'.repeat(LARGE_PASTE_BYTES), false)).toEqual({ kind: 'inline' })
    expect(decideTextPaste('x'.repeat(LARGE_PASTE_BYTES + 1), false)).toEqual({ kind: 'fold', bytes: LARGE_PASTE_BYTES + 1 })
    expect(decideTextPaste('x'.repeat(LARGE_PASTE_BYTES + 1), true)).toEqual({ kind: 'inline' })
  })
  it('recognises the raw-paste chord on either platform modifier', () => {
    expect(isRawPasteChord({ key: 'V', shiftKey: true, metaKey: true, ctrlKey: false })).toBe(true)
    expect(isRawPasteChord({ key: 'v', shiftKey: true, metaKey: false, ctrlKey: true })).toBe(true)
    expect(isRawPasteChord({ key: 'v', shiftKey: false, metaKey: true, ctrlKey: false })).toBe(false)
  })
})

describe('useComposerIntake', () => {
  let root: Root
  function mount(): void {
    root = createRoot(document.createElement('div'))
    act(() => root.render(<Probe />))
  }
  afterEach(() => { act(() => root.unmount()); vi.clearAllMocks(); pathFor = () => ''; caps = []; tabEnvironment = 'local' })

  it('marks the window as a drop target while files are dragged over it', () => {
    mount()
    act(() => { window.dispatchEvent(dragEvent('dragenter', [])) })
    expect(useComposerDragStore.getState().dragging).toBe(true)
    act(() => { window.dispatchEvent(dragEvent('dragleave', [])) })
    expect(useComposerDragStore.getState().dragging).toBe(false)
  })

  it('attaches a dropped file by path when the host can name it', async () => {
    pathFor = () => '/work/a.txt'
    caps = ['nativeShell']
    mount()
    act(() => { window.dispatchEvent(dragEvent('drop', [new File(['hi'], 'a.txt')])) })
    await settle()
    expect(attachFileByPath).toHaveBeenCalledWith('tab-1', '/work/a.txt')
    expect(addAttachments).toHaveBeenCalledWith([expect.objectContaining({ path: '/work/a.txt' })])
    expect(useComposerDragStore.getState().dragging).toBe(false)
  })

  it('uploads a Finder drop onto a remote conversation, since its path is only on this machine', async () => {
    pathFor = () => '/Users/me/a.txt'
    caps = ['nativeShell']
    tabEnvironment = 'remote-host'
    mount()
    act(() => { window.dispatchEvent(dragEvent('drop', [new File(['hi'], 'a.txt')])) })
    await settle()
    expect(attachFileByPath).not.toHaveBeenCalled()
    expect(saveAttachmentData).toHaveBeenCalledWith('tab-1', 'a.txt', btoa('hi'))
  })

  it('uploads a dropped file the host has no path for', async () => {
    mount()
    act(() => { window.dispatchEvent(dragEvent('drop', [new File(['hi'], 'b.txt')])) })
    await settle()
    expect(saveAttachmentData).toHaveBeenCalledWith('tab-1', 'b.txt', btoa('hi'))
    expect(addAttachments).toHaveBeenCalledWith([expect.objectContaining({ name: 'b.txt' })])
  })

  it('folds an oversized paste into an attachment and keeps it out of the editor', async () => {
    mount()
    const event = pasteEvent('y'.repeat(LARGE_PASTE_BYTES + 10))
    expect(intake.handlePaste(event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    await settle()
    // The conversation's id rides along so the text lands on its Environment.
    expect(saveAttachmentData.mock.calls[0][0]).toBe('tab-1')
    expect(saveAttachmentData.mock.calls[0][1]).toMatch(/^pasted-text-\d+\.txt$/)
    expect(addAttachments).toHaveBeenCalledTimes(1)
  })

  it('leaves a small paste, and a raw paste of any size, to the editor', () => {
    mount()
    expect(intake.handlePaste(pasteEvent('short'))).toBe(false)
    intake.noteKeyDown(new KeyboardEvent('keydown', { key: 'v', shiftKey: true, metaKey: true }))
    expect(intake.handlePaste(pasteEvent('y'.repeat(LARGE_PASTE_BYTES + 10)))).toBe(false)
    expect(saveAttachmentData).not.toHaveBeenCalled()
  })

  it('names a pasted clipboard image so it can be told apart', async () => {
    mount()
    expect(intake.handlePaste(pasteEvent('', [new File(['png'], 'image.png', { type: 'image/png' })]))).toBe(true)
    await settle()
    expect(saveAttachmentData.mock.calls[0][1]).toMatch(/^pasted image \d+\.png$/)
  })
})
