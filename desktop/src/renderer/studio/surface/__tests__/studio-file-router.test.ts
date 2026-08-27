// @vitest-environment jsdom
/**
 * file-open-router seam: Studio registers a router and file opens route to
 * surface tabs; no router (overlay) → legacy fallback path is taken by the
 * call sites (pinned here through the router contract itself).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'

const { openFileInEditorMock, getSessionStateMock } = vi.hoisted(() => ({
  openFileInEditorMock: vi.fn(),
  getSessionStateMock: vi.fn(),
}))
vi.mock('../../../rendererLogger', () => ({ rDebug: vi.fn(), rTrace: vi.fn(), rWarn: vi.fn() }))

vi.mock('../../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => getSessionStateMock() },
}))

import { registerSurfaceFileRouter, surfaceRouter } from '../../../lib/file-open-router'
import { registerStudioFileRouter } from '../studio-file-router'
import { useSurfaceStore } from '../surface-store'
import { runtimePanel } from '../runtime-panel-registry'

beforeEach(() => {
  openFileInEditorMock.mockClear()
  getSessionStateMock.mockReset()
  getSessionStateMock.mockReturnValue({
    tabs: [{ id: 'tab-1', workingDirectory: '/repo' }],
    activeTabId: 'tab-1',
    conversationPanes: new Map(),
    openFileInEditor: openFileInEditorMock,
  })
  ;(window as unknown as { ion: unknown }).ion = {
    studioSetSetting: vi.fn().mockResolvedValue(true),
    studioGetSettings: vi.fn().mockResolvedValue({}),
    terminalDestroy: vi.fn().mockResolvedValue(undefined),
    studioBrowserViewEnsure: vi.fn().mockResolvedValue(true),
    studioBrowserViewBounds: vi.fn(),
    studioBrowserViewNavigate: vi.fn().mockResolvedValue(true),
    studioBrowserViewAction: vi.fn().mockResolvedValue(true),
    studioBrowserViewClose: vi.fn().mockResolvedValue(true),
    onStudioBrowserViewState: vi.fn(() => () => undefined),
  }
  useSurfaceStore.setState({ tabs: [], activeTabId: null, pinnedTabs: ['plan'], notification: null, conversations: {}, currentConversationId: 'tab-1', visible: false, hydrated: true, diffReveal: null })
})
afterEach(() => {
  // Router is module-global; clear between tests via a fresh no-op register.
  registerSurfaceFileRouter({
    openTextFile: () => undefined,
    openImage: () => undefined,
    openHtml: () => undefined,
    openGitDiff: () => false,
  })()
})

describe('file-open-router', () => {
  it('no registration → surfaceRouter() is null (overlay legacy path)', () => {
    expect(surfaceRouter()).toBeNull()
  })

  it('register/unregister round-trips', () => {
    const r = { openTextFile: vi.fn(), openImage: vi.fn(), openHtml: vi.fn(), openGitDiff: vi.fn() }
    const off = registerSurfaceFileRouter(r)
    expect(surfaceRouter()).toBe(r)
    off()
    expect(surfaceRouter()).toBeNull()
  })

  it('studio router: text file → editor surface tab + buffer materialization', () => {
    registerStudioFileRouter()
    surfaceRouter()!.openTextFile('/repo', 'tab-1', '/repo/src/a.ts')
    const s = useSurfaceStore.getState()
    expect(s.activeTabId).toBe('file:/repo/src/a.ts')
    expect(openFileInEditorMock).toHaveBeenCalledWith('/repo', 'tab-1', '/repo/src/a.ts')
  })

  it('studio router: image → preview tab', () => {
    registerStudioFileRouter()
    surfaceRouter()!.openImage('/repo/shot.png')
    expect(useSurfaceStore.getState().activeTabId).toBe('preview:/repo/shot.png')
  })

  it('studio router: html → RESTRICTED browser preview tab (D6)', () => {
    registerStudioFileRouter()
    surfaceRouter()!.openHtml('/repo/page.html')
    const tab = useSurfaceStore.getState().tabs.find((t) => t.kind === 'browser')
    expect(tab).toMatchObject({ url: 'file:///repo/page.html', mode: 'preview' })
  })

  it('studio router: active-checkout git diff reveals singleton with staged identity', () => {
    registerStudioFileRouter()
    const handled = surfaceRouter()!.openGitDiff({ repoDir: '/repo', filePath: 'src/x.ts', staged: false })
    const s = useSurfaceStore.getState()
    expect(handled).toBe(true)
    expect(s.activeTabId).toBe('diff')
    expect(s.diffReveal).toMatchObject({ filePath: 'src/x.ts', staged: false })
  })

  it('studio router: secondary workspace git diff keeps singleton unbound', () => {
    registerStudioFileRouter()
    const handled = surfaceRouter()!.openGitDiff({ repoDir: '/repo/secondary', filePath: 'src/x.ts', staged: false })
    const s = useSurfaceStore.getState()
    expect(handled).toBe(false)
    expect(s.activeTabId).toBeNull()
    expect(s.diffReveal).toBeNull()
  })

  it('opens latest plan in Plan Canvas without materializing a file editor', () => {
    ;getSessionStateMock.mockReturnValue({
      tabs: [{ id: 'tab-1', workingDirectory: '/repo' }],
      activeTabId: 'tab-1',
      conversationPanes: new Map([['tab-1', {
        activeInstanceId: 'main',
        instances: [{ id: 'main', planFilePath: null, messages: [
          { role: 'system', content: '── Implementing plan', planFilePath: '/plans/current.md' },
        ] }],
      }]]),
      openFileInEditor: openFileInEditorMock,
    })
    registerStudioFileRouter()

    surfaceRouter()!.openPlan!('/repo', 'tab-1', '/plans/current.md')

    expect(useSurfaceStore.getState().activeTabId).toBe('plan')
    expect(openFileInEditorMock).not.toHaveBeenCalled()
  })

  it('opens older plan in a normal file surface tab', () => {
    ;getSessionStateMock.mockReturnValue({
      tabs: [{ id: 'tab-1', workingDirectory: '/repo' }],
      activeTabId: 'tab-1',
      conversationPanes: new Map([['tab-1', {
        activeInstanceId: 'main',
        instances: [{ id: 'main', planFilePath: '/plans/current.md', messages: [] }],
      }]]),
      openFileInEditor: openFileInEditorMock,
    })
    registerStudioFileRouter()

    surfaceRouter()!.openPlan!('/repo', 'tab-1', '/plans/earlier.md')

    expect(useSurfaceStore.getState().activeTabId).toBe('file:/plans/earlier.md')
    expect(openFileInEditorMock).toHaveBeenCalledWith('/repo', 'tab-1', '/plans/earlier.md')
  })

  it('studio router: dispatch clicks reuse one conversation preview tab', () => {
    registerStudioFileRouter()
    const router = surfaceRouter()!
    router.openDispatch!('dev-lead', 'dispatch-1', 'Dev Lead')
    router.openDispatch!('test-lead', 'dispatch-2', 'Test Lead')

    expect(useSurfaceStore.getState().tabs.filter((tab) => tab.kind === 'dispatch')).toEqual([{
      kind: 'dispatch',
      id: 'dispatch-preview',
      agentName: 'test-lead',
      dispatchId: 'dispatch-2',
      title: 'Test Lead',
    }])
  })

  it('updates panel content and title without stealing active focus', () => {
    registerStudioFileRouter()
    const router = surfaceRouter()!
    const id = router.openPanel!('Loading', React.createElement('div', null, 'Loading conflict state…'), vi.fn())
    useSurfaceStore.getState().openSingleton('diff')

    router.updatePanel!(id, 'Conflicts', React.createElement('div', null, 'engine/internal/backend/runloop.go'))

    expect(useSurfaceStore.getState().activeTabId).toBe('diff')
    expect(useSurfaceStore.getState().tabs.find((tab) => tab.id === id)).toMatchObject({ title: 'Conflicts' })
    expect((runtimePanel(id)?.body as React.ReactElement<{ children: React.ReactNode }>).props.children).toBe('engine/internal/backend/runloop.go')
  })

  it('releases parent-closed runtime panels', () => {
    registerStudioFileRouter()
    const id = surfaceRouter()!.openPanel!('Conflict', React.createElement('div'), vi.fn())
    surfaceRouter()!.closePanel!(id)

    expect(runtimePanel(id)).toBeNull()
    expect(useSurfaceStore.getState().tabs.some((tab) => tab.id === id)).toBe(false)
  })
})

describe('openUrl — clicked links', () => {
  it('opens a NEW browser tab for every click', () => {
    registerStudioFileRouter()
    expect(surfaceRouter()!.openUrl!('https://example.test/one')).toBe(true)
    expect(surfaceRouter()!.openUrl!('https://example.test/two')).toBe(true)

    const browsers = useSurfaceStore.getState().tabs.filter((tab) => tab.kind === 'browser')
    // A tab per click, deliberately: reusing one would destroy the page the
    // previous link came from, which is the page the operator is comparing to.
    expect(browsers).toHaveLength(2)
    expect(browsers.map((tab) => (tab.kind === 'browser' ? tab.url : ''))).toEqual([
      'https://example.test/one',
      'https://example.test/two',
    ])
  })

  it('uses browse mode so the page can load', () => {
    registerStudioFileRouter()
    surfaceRouter()!.openUrl!('https://example.test/docs')
    const browser = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'browser')
    // A preview tab carries the offline network shield, which would leave a
    // link the operator explicitly opened unable to load.
    expect(browser && browser.kind === 'browser' && browser.mode).toBe('browse')
  })

  it('reveals the surface and focuses the new tab', () => {
    const reveal = vi.fn()
    registerStudioFileRouter(reveal)
    surfaceRouter()!.openUrl!('https://example.test/docs')
    expect(reveal).toHaveBeenCalled()
    const browser = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'browser')
    expect(useSurfaceStore.getState().activeTabId).toBe(browser?.id)
  })

  it('links the first clicked link tab to the agent', () => {
    // A clicked link is a normal browser tab, so the single-link rule applies
    // to it unchanged: the conversation's first browser tab takes the link.
    registerStudioFileRouter()
    surfaceRouter()!.openUrl!('https://example.test/one')
    surfaceRouter()!.openUrl!('https://example.test/two')
    const conversation = useSurfaceStore.getState().conversations['tab-1']
    const first = useSurfaceStore.getState().tabs.find((tab) => tab.kind === 'browser')
    expect(conversation?.agentBrowserInstanceId).toBe(first && first.kind === 'browser' ? first.instanceId : null)
  })
})
