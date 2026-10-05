// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  selectTab: vi.fn(),
  openSettings: vi.fn(),
  openFileInEditor: vi.fn(),
  openDeepLink: vi.fn(),
  answerDeepLink: vi.fn(),
  capabilities: vi.fn<() => string[]>(() => []),
  writeText: vi.fn(() => Promise.resolve()),
}))

vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ selectTab: m.selectTab, openSettings: m.openSettings, openFileInEditor: m.openFileInEditor, activeTabId: 'active' }) },
}))
vi.mock('../host/host-instance', () => ({
  host: { capabilities: m.capabilities, shell: { openDeepLink: m.openDeepLink, answerDeepLink: m.answerDeepLink } },
}))
vi.mock('../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn() }))

import { answerRemoteDeepLink, copyDeepLink, navigateToDeepLinkTarget, onRemoteDeepLinkConfirm, openDeepLinkUrl } from '../deeplink-client'

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(navigator, { clipboard: { writeText: m.writeText } })
})

describe('navigateToDeepLinkTarget', () => {
  it('moves the view for each route', () => {
    navigateToDeepLinkTarget({ route: 'conversation', conversationId: 'c1', tabId: 't1' })
    navigateToDeepLinkTarget({ route: 'settings', panel: 'git-access', pageId: 'git-access', projectable: false })
    navigateToDeepLinkTarget({ route: 'file', dir: '/repo', path: '/repo/a.ts' })
    expect(m.selectTab).toHaveBeenCalledWith('t1')
    expect(m.openSettings).toHaveBeenCalledWith('git-access')
    expect(m.openFileInEditor).toHaveBeenCalledWith('/repo', 'active', '/repo/a.ts')
  })
})

describe('openDeepLinkUrl', () => {
  it('navigates on a navigate result', async () => {
    m.openDeepLink.mockResolvedValue({ kind: 'navigate', target: { route: 'conversation', conversationId: 'c1', tabId: 't1' } })
    await openDeepLinkUrl('ion://conversation?id=c1')
    expect(m.openDeepLink).toHaveBeenCalledWith('ion://conversation?id=c1')
    expect(m.selectTab).toHaveBeenCalledWith('t1')
  })

  it('hands a confirmation to the dialog', async () => {
    const seen: unknown[] = []
    const off = onRemoteDeepLinkConfirm((r) => seen.push(r))
    m.openDeepLink.mockResolvedValue({ kind: 'confirm', id: 'rdl-1', request: { id: 'rdl-1', owner: 'remote', action: 'prompt' } })
    await openDeepLinkUrl('ion://prompt?dir=/r&text=x')
    off()
    expect(seen).toEqual([{ id: 'rdl-1', owner: 'remote', action: 'prompt' }])
  })
})

describe('answerRemoteDeepLink', () => {
  it('opens the conversation the approved action ran in', async () => {
    m.answerDeepLink.mockResolvedValue({ ok: true, tabId: 't9' })
    await answerRemoteDeepLink('rdl-1', true)
    expect(m.answerDeepLink).toHaveBeenCalledWith({ id: 'rdl-1', owner: 'remote', approved: true })
    expect(m.selectTab).toHaveBeenCalledWith('t9')
  })
})

describe('copyDeepLink', () => {
  it('copies ion:// on the desktop and https in a browser', async () => {
    m.capabilities.mockReturnValue(['deeplink'])
    await copyDeepLink('ion://conversation?id=c1')
    expect(m.writeText).toHaveBeenLastCalledWith('ion://conversation?id=c1')

    m.capabilities.mockReturnValue([])
    await copyDeepLink('ion://conversation?id=c1')
    expect(m.writeText).toHaveBeenLastCalledWith(`${window.location.origin}/open/conversation?id=c1`)
  })
})
