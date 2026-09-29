/**
 * An attachment opens where it belongs: images in the image preview, text in
 * a Studio file tab, and anything else in the operator's own application,
 * through a local copy when the file lives on a remote Environment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const openFileInEditor = vi.fn()
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: { getState: () => ({
    tabs: [{ id: 'tab-1', workingDirectory: '/work' }],
    settledHistory: [],
    openFileInEditor,
  }) },
  isTextFile: (name: string) => !/\.(docx|pptx|pdf|xlsx|png)$/.test(name),
}))
vi.mock('../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn() }))
let environment = 'local'
vi.mock('../studio/connection/tab-environment', () => ({ environmentOfTab: () => environment }))
const router = { openImage: vi.fn(), openTextFile: vi.fn() }
let routed = true
vi.mock('./file-open-router', () => ({ contentRouter: () => (routed ? router : null) }))
let caps = ['nativeShell']
const fsOpenNative = vi.fn(async () => ({ ok: true }))
const fsOpenNativeData = vi.fn(async () => ({ ok: true }))
const readFileData = vi.fn(async () => ({ base64: 'UEsDBA==', size: 4 }))
vi.mock('../host/host-instance', () => ({
  host: { capabilities: () => caps, shell: {
    fsOpenNative: (...a: unknown[]) => fsOpenNative(...(a as [])),
    fsOpenNativeData: (...a: unknown[]) => fsOpenNativeData(...(a as [])),
    readFileData: (...a: unknown[]) => readFileData(...(a as [])),
  } },
}))

import { attachmentOpenKind, openAttachment } from './open-attachment'

afterEach(() => { vi.clearAllMocks(); environment = 'local'; routed = true; caps = ['nativeShell'] })

describe('attachmentOpenKind', () => {
  it('reads the kind from the display name, falling back to the stored path', () => {
    expect(attachmentOpenKind({ name: 'pasted-text-1.txt', path: '/data/ab12.txt' })).toBe('text')
    expect(attachmentOpenKind({ name: 'notes.md', path: '/x/notes.md' })).toBe('text')
    expect(attachmentOpenKind({ name: 'shot.png', path: '/x/shot.png' })).toBe('image')
    expect(attachmentOpenKind({ name: 'Report.docx', path: '/x/ab.docx' })).toBe('native')
    expect(attachmentOpenKind({ name: 'Deck', path: '/x/ab.pptx' })).toBe('native')
  })
})

describe('openAttachment', () => {
  it('opens a pasted text file in a Studio file tab in the conversation\'s directory', async () => {
    await openAttachment('tab-1', { name: 'pasted-text-1.txt', path: '/data/ab12.txt' })
    expect(router.openTextFile).toHaveBeenCalledWith('/work', 'tab-1', '/data/ab12.txt')
    expect(openFileInEditor).not.toHaveBeenCalled()
  })

  it('opens an image in the image preview, carrying its inline data', async () => {
    await openAttachment('tab-1', { name: 'shot.png', path: '/x/shot.png', dataUrl: 'data:image/png;base64,AA' })
    expect(router.openImage).toHaveBeenCalledWith('/x/shot.png', 'data:image/png;base64,AA')
  })

  it('hands a local Word document straight to the native app', async () => {
    await openAttachment('tab-1', { name: 'Report.docx', path: '/x/Report.docx' })
    expect(fsOpenNative).toHaveBeenCalledWith('/x/Report.docx')
    expect(readFileData).not.toHaveBeenCalled()
  })

  it('opens a remote Word document from a local copy under its display name', async () => {
    environment = 'remote-host'
    await openAttachment('tab-1', { name: 'Report.docx', path: '/srv/ab.docx' })
    expect(readFileData).toHaveBeenCalledWith('tab-1', '/srv/ab.docx')
    expect(fsOpenNativeData).toHaveBeenCalledWith('Report.docx', 'UEsDBA==')
    expect(fsOpenNative).not.toHaveBeenCalled()
  })

  it('falls back to the floating editor when no Studio surface is registered', async () => {
    routed = false
    await openAttachment('tab-1', { name: 'a.txt', path: '/x/a.txt' })
    expect(openFileInEditor).toHaveBeenCalledWith('/work', 'tab-1', '/x/a.txt')
  })
})
