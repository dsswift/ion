// @vitest-environment jsdom
/**
 * Attachment staging decides, per file, whether a conversation gets a path or
 * the bytes. Pins: a path is used only for this machine's own conversations,
 * an upload is sent to the target Environment explicitly, a capture name is
 * given to nameless frames, and a native capture reaches a remote
 * conversation as an upload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const addAttachments = vi.fn()
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ activeTabId: 'tab-1', addAttachments }) },
}))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rError: vi.fn(), rInfo: vi.fn() }))

const targets: Array<string | null> = []
let explicit: string | null = null
let tabEnvironment: string | null = 'local'
vi.mock('../../studio/connection/tab-environment', () => ({
  environmentOfTab: () => tabEnvironment,
  withTargetEnvironment: <T,>(id: string, fn: () => T): T => {
    explicit = id
    try { return fn() } finally { explicit = null }
  },
}))

let caps: string[] = []
let pathFor: (file: File) => string = () => ''
const attachFileByPath = vi.fn(async (_tabId: string, path: string) => ({ id: `p:${path}`, type: 'file' as const, name: 'a.txt', path }))
const saveAttachmentData = vi.fn(async (_tabId: string, name: string, _base64: string) => {
  targets.push(explicit)
  return { id: `u:${name}`, type: 'file' as const, name, path: `/data/${name}` }
})
vi.mock('../../host/host-instance', () => ({
  host: { capabilities: () => caps, shell: {
    getPathForFile: (file: File) => pathFor(file),
    attachFileByPath: (tabId: string, path: string) => attachFileByPath(tabId, path),
    saveAttachmentData: (tabId: string, name: string, base64: string) => saveAttachmentData(tabId, name, base64),
  } },
}))

import { stageFilesFor, stageFiles, stageNativeCapture } from './attachment-staging'

describe('attachment staging', () => {
  afterEach(() => {
    vi.clearAllMocks()
    targets.length = 0
    caps = []
    pathFor = () => ''
    tabEnvironment = 'local'
  })

  it('attaches by path only when the target is this machine', async () => {
    caps = ['nativeShell']
    pathFor = () => '/Users/me/a.png'
    await stageFilesFor([new File(['x'], 'a.png')], 'pick', { tabId: 'tab-1', environmentId: 'local' })
    expect(attachFileByPath).toHaveBeenCalledWith('tab-1', '/Users/me/a.png')

    const staged = await stageFilesFor([new File(['x'], 'a.png')], 'pick', { tabId: 'q-tab', environmentId: 'box' })
    expect(saveAttachmentData).toHaveBeenCalledWith('q-tab', 'a.png', btoa('x'))
    expect(targets).toEqual(['box'])
    expect(staged).toEqual([expect.objectContaining({ path: '/data/a.png' })])
  })

  it('names a captured frame as a screenshot', async () => {
    await stageFiles([new File(['png'], 'screenshot.png', { type: 'image/png' })], 'capture')
    expect(saveAttachmentData.mock.calls[0][1]).toMatch(/^screenshot \d+\.png$/)
    expect(addAttachments).toHaveBeenCalledTimes(1)
  })

  it('keeps a native capture as is for a local conversation', async () => {
    const shot = { id: 's', type: 'image' as const, name: 'screenshot 1.png', path: '/u/s.png', dataUrl: 'data:image/png;base64,QUJD' }
    await stageNativeCapture(shot)
    expect(addAttachments).toHaveBeenCalledWith([shot])
    expect(saveAttachmentData).not.toHaveBeenCalled()
  })

  it('uploads a native capture to a remote conversation', async () => {
    tabEnvironment = 'box'
    const shot = { id: 's', type: 'image' as const, name: 'screenshot 1.png', path: '/u/s.png', dataUrl: 'data:image/png;base64,QUJD' }
    await stageNativeCapture(shot)
    expect(saveAttachmentData).toHaveBeenCalledWith('tab-1', 'screenshot 1.png', 'QUJD')
    expect(targets).toEqual(['box'])
    expect(addAttachments).toHaveBeenCalledWith([expect.objectContaining({ path: '/data/screenshot 1.png' })])
  })
})
