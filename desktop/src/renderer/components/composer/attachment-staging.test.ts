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
const notices: Array<{ tabId: string; message: string; level: string }> = []
vi.mock('../../lib/tab-notice', () => ({ showTabNotice: (tabId: string, message: string, level: string) => notices.push({ tabId, message, level }) }))

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
    notices.length = 0
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

  describe('a file that cannot be attached says so', () => {
    const big = (bytes: number, name: string, type: string): File => new File([new Uint8Array(bytes)], name, { type })

    it('refuses an oversize non-image before sending it, with its size and the limit', async () => {
      const staged = await stageFilesFor([big(40_274_602, 'recording.mov', 'video/quicktime')], 'pick', { tabId: 'tab-1', environmentId: 'box' })

      expect(staged).toEqual([])
      expect(saveAttachmentData).not.toHaveBeenCalled()
      expect(notices).toEqual([{ tabId: 'tab-1', level: 'warning', message: 'recording.mov is too large to attach (38 MB; the limit is 25 MB).' }])
    })

    it('says an image the browser cannot shrink is too large, naming that as the reason', async () => {
      await stageFilesFor([big(40_274_602, 'IMG_9.heic', 'image/heic')], 'pick', { tabId: 'tab-1', environmentId: 'box' })

      expect(notices[0].message).toBe('IMG_9.heic is an image this browser cannot shrink, and it is too large to attach (38 MB; the limit is 25 MB).')
    })

    it('passes along the reason the server gave when it refuses', async () => {
      saveAttachmentData.mockRejectedValueOnce(Object.assign(new Error('a.txt could not be attached because its data was not in a form the server accepts.'), { code: 'attachment_malformed' }))
      await stageFilesFor([new File(['x'], 'a.txt')], 'pick', { tabId: 'tab-1', environmentId: 'box' })

      expect(notices[0].message).toBe('a.txt could not be attached because its data was not in a form the server accepts.')
    })

    it('gives a plain message when the connection fails rather than the server refusing', async () => {
      saveAttachmentData.mockRejectedValueOnce(new Error('fs.saveAttachmentData timed out after 30000ms'))
      await stageFilesFor([new File(['x'], 'a.txt')], 'pick', { tabId: 'tab-1', environmentId: 'box' })

      expect(notices[0].message).toBe('The server could not store a.txt. Try again.')
    })

    it('says so when the server answers with nothing', async () => {
      saveAttachmentData.mockResolvedValueOnce(null as never)
      await stageFilesFor([new File(['x'], 'a.txt')], 'pick', { tabId: 'tab-1', environmentId: 'box' })

      expect(notices[0].message).toBe('The server could not store a.txt. Try again.')
    })

    it('hands each refusal to the caller that asked, so a screen without the composer can show it itself', async () => {
      const seen: string[] = []
      await stageFilesFor([big(30 * 1024 * 1024, 'a.pdf', 'application/pdf')], 'pick', { tabId: 'q', environmentId: 'box' }, (message) => seen.push(message))

      expect(seen).toEqual(['a.pdf is too large to attach (30 MB; the limit is 25 MB).'])
      expect(notices).toEqual([])
    })

    it('still attaches the files that were fine when another in the same pick is refused', async () => {
      const staged = await stageFilesFor([new File(['ok'], 'ok.txt'), big(30 * 1024 * 1024, 'huge.pdf', 'application/pdf')], 'pick', { tabId: 'tab-1', environmentId: 'box' })

      expect(staged).toHaveLength(1)
      expect(notices).toHaveLength(1)
    })

    it('says so when a native capture upload to a remote conversation is refused', async () => {
      tabEnvironment = 'box'
      saveAttachmentData.mockRejectedValueOnce(Object.assign(new Error('screenshot 1.png is too large to attach (40 MB; the limit is 25 MB).'), { code: 'attachment_too_large' }))
      await stageNativeCapture({ id: 's', type: 'image' as const, name: 'screenshot 1.png', path: '/u/s.png', dataUrl: 'data:image/png;base64,QUJD' })

      expect(notices[0].message).toBe('screenshot 1.png is too large to attach (40 MB; the limit is 25 MB).')
      expect(addAttachments).not.toHaveBeenCalled()
    })
  })
})
