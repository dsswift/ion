/**
 * A clicked file path opens on the machine that owns the conversation: the
 * server there resolves it, text and images open in Studio wherever they
 * live, and a file Studio cannot show opens natively when it is on this
 * machine or is offered as a download (Save dialog in Downloads) when it is
 * on another one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const notices: Array<{ tabId: string; message: string }> = []
vi.mock('./tab-notice', () => ({ showTabNotice: (tabId: string, message: string) => notices.push({ tabId, message }) }))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ openFileInEditor: vi.fn() }) },
  isTextFile: (name: string) => !/\.(docx|pptx|pdf|xlsx|png|jpg|svg)$/.test(name),
}))
vi.mock('../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn() }))
let environment = 'local'
vi.mock('../studio/connection/tab-environment', () => ({ environmentOfTab: () => environment }))
const router = { openImage: vi.fn(), openTextFile: vi.fn(), openHtml: vi.fn() }
vi.mock('./file-open-router', () => ({ contentRouter: () => router }))
let caps = ['nativeShell']
let target = { path: '/srv/work/report.docx', exists: true, isDirectory: false, size: 4 }
const resolveFileLink = vi.fn(async () => target)
const fsOpenNative = vi.fn(async () => ({ ok: true }))
const fsOpenNativeData = vi.fn(async () => ({ ok: true }))
const fsSaveData = vi.fn(async () => ({ filePath: '/Users/me/Downloads/report.docx' }))
const readFileData = vi.fn(async () => ({ base64: 'UEsDBA==', size: 4 }))
vi.mock('../host/host-instance', () => ({
  host: { capabilities: () => caps, shell: {
    resolveFileLink: (...a: unknown[]) => resolveFileLink(...(a as [])),
    fsOpenNative: (...a: unknown[]) => fsOpenNative(...(a as [])),
    fsOpenNativeData: (...a: unknown[]) => fsOpenNativeData(...(a as [])),
    fsSaveData: (...a: unknown[]) => fsSaveData(...(a as [])),
    readFileData: (...a: unknown[]) => readFileData(...(a as [])),
  } },
}))

import { fileLinkAction, openFileLink } from './open-file-link'

afterEach(() => {
  vi.clearAllMocks()
  notices.length = 0
  environment = 'local'
  caps = ['nativeShell']
  target = { path: '/srv/work/report.docx', exists: true, isDirectory: false, size: 4 }
})

const click = (path: string, event?: { metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }) =>
  openFileLink({ tabId: 'tab-1', path, cwd: '/srv/work', event: event ?? { metaKey: true }, tag: 'test' })

describe('fileLinkAction', () => {
  it('shows what Ion can show wherever the file lives', () => {
    for (const here of [true, false]) {
      expect(fileLinkAction('/a/notes.md', 'view', here)).toBe('text')
      expect(fileLinkAction('/a/data.json', 'view', here)).toBe('text')
      expect(fileLinkAction('/a/shot.png', 'view', here)).toBe('image')
    }
  })

  it('renders HTML only from this machine, and reads its source otherwise', () => {
    expect(fileLinkAction('/a/page.html', 'view', true)).toBe('html')
    expect(fileLinkAction('/a/page.html', 'view', false)).toBe('text')
    expect(fileLinkAction('/a/page.html', 'source', true)).toBe('text')
  })

  it('opens a file Ion cannot show natively here, and offers a download from elsewhere', () => {
    expect(fileLinkAction('/a/report.docx', 'view', true)).toBe('native')
    expect(fileLinkAction('/a/report.docx', 'view', false)).toBe('save-copy')
  })

  it('treats ⌥⌘ as "my own application", through a local copy for a remote file', () => {
    expect(fileLinkAction('/a/notes.md', 'native', true)).toBe('native')
    expect(fileLinkAction('/a/notes.md', 'native', false)).toBe('open-copy')
  })
})

describe('openFileLink', () => {
  it('asks the owning server to resolve the path as written', async () => {
    target = { path: '/home/remote/.ion/notes.md', exists: true, isDirectory: false, size: 10 }
    environment = 'remote-host'
    await click('~/.ion/notes.md')
    expect(resolveFileLink).toHaveBeenCalledWith('tab-1', '~/.ion/notes.md', '/srv/work')
    expect(router.openTextFile).toHaveBeenCalledWith('/srv/work', 'tab-1', '/home/remote/.ion/notes.md')
  })

  it('offers a remote Word document as a download under its own name', async () => {
    environment = 'remote-host'
    await click('report.docx')
    expect(readFileData).toHaveBeenCalledWith('tab-1', '/srv/work/report.docx')
    expect(fsSaveData).toHaveBeenCalledWith('report.docx', 'UEsDBA==')
    expect(fsOpenNative).not.toHaveBeenCalled()
    expect(notices).toEqual([])
  })

  it('opens a remote file as a local copy on ⌥⌘', async () => {
    environment = 'remote-host'
    await click('report.docx', { metaKey: true, altKey: true })
    expect(fsOpenNativeData).toHaveBeenCalledWith('report.docx', 'UEsDBA==')
    expect(fsSaveData).not.toHaveBeenCalled()
  })

  it('hands a local Word document straight to its application', async () => {
    await click('report.docx')
    expect(fsOpenNative).toHaveBeenCalledWith('/srv/work/report.docx')
    expect(readFileData).not.toHaveBeenCalled()
  })

  it('says so when the path is missing or too large to copy, instead of doing nothing', async () => {
    target = { path: '/srv/work/gone.md', exists: false, isDirectory: false, size: 0 }
    await click('gone.md')
    environment = 'remote-host'
    target = { path: '/srv/work/huge.pdf', exists: true, isDirectory: false, size: 30 * 1024 * 1024 }
    await click('huge.pdf')
    expect(readFileData).not.toHaveBeenCalled()
    expect(notices.map((n) => n.message)).toEqual([
      '/srv/work/gone.md was not found.',
      'huge.pdf is 30 MB. Files over 25 MB cannot be copied from another machine.',
    ])
  })
})
