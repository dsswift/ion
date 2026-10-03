// @vitest-environment jsdom
/**
 * initTabsSyncFromWire — the browser-host bridge for tabs sync. Unlike the
 * other windowMirrorSync-gated syncs, tabs are not skippable for a browser:
 * tabsReady is set only by hydrateTabsFromSync, and InputBar/TabStrip block
 * on it. This pins that studio_welcome, studio_snapshot, and the
 * studio:tabs-sync studio_event channel all correctly populate the store,
 * using the real hydrateTabsFromSync (not mocked) the same way
 * user-message-echo.test.ts does for the Electron path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

const { onFrame } = vi.hoisted(() => ({ onFrame: vi.fn() }))
vi.mock('../../../host/host-instance', () => ({ host: { onFrame } }))

import { initTabsSyncFromWire } from '../secondary-store'

function tab(id: string) {
  return {
    id, conversationId: `conv-${id}`, title: id, customTitle: null,
    workingDirectory: '/repo', hasChosenDirectory: true, additionalDirs: [],
  }
}

let frameHandler: ((environmentId: string, frame: StudioFrame) => void) | undefined

beforeEach(() => {
  useSessionStore.setState({ tabs: [], settledHistory: [], activeTabId: undefined, conversationPanes: new Map(), tabsReady: false })
  onFrame.mockClear()
  onFrame.mockImplementation((cb: typeof frameHandler) => {
    frameHandler = cb
    return vi.fn()
  })
})

describe('initTabsSyncFromWire', () => {
  it('hydrates a remote environment\'s tabs into the same store, tagged, beside the local ones (union store)', () => {
    initTabsSyncFromWire()
    frameHandler?.(LOCAL_ENVIRONMENT_ID, {
      type: 'studio_snapshot',
      snapshot: { tabs: [tab('a')], settings: {} as never, worktrees: {} as never, terminals: { revision: 0, panes: [], openTabIds: [] } as never, automations: [], engine: {} as never, presence: { entries: [], driving: {} } },
    })
    frameHandler?.('devbox', {
      type: 'studio_snapshot',
      snapshot: { tabs: [tab('z')], settings: {} as never, worktrees: {} as never, terminals: { revision: 0, panes: [], openTabIds: [] } as never, automations: [], engine: {} as never, presence: { entries: [], driving: {} } },
    })
    expect(useSessionStore.getState().tabs.map((t) => [t.id, t.environmentId])).toEqual([['a', LOCAL_ENVIRONMENT_ID], ['z', 'devbox']])
    // A later local re-publish touches only the local slice.
    frameHandler?.(LOCAL_ENVIRONMENT_ID, { type: 'studio_event', channel: 'studio:tabs-sync', payload: { tabs: [tab('a'), tab('b')] } })
    expect(useSessionStore.getState().tabs.map((t) => t.id)).toEqual(['a', 'b', 'z'])
    // And devbox closing its tab removes only that one.
    frameHandler?.('devbox', { type: 'studio_event', channel: 'studio:tabs-sync', payload: { tabs: [] } })
    expect(useSessionStore.getState().tabs.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('hydrates tabs and sets tabsReady from a studio_welcome frame', () => {
    initTabsSyncFromWire()
    frameHandler?.(LOCAL_ENVIRONMENT_ID, {
      type: 'studio_welcome', protocolVersion: 1, environmentId: 'browser', label: 'x',
      platform: 'linux', serverVersion: '1', engineVersion: '1', capabilities: [],
      principal: { subject: 'p', displayName: 'p' }, scopes: [], enterprisePolicy: null, settingsHiddenGroups: [],
    developerSurfaces: { sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: true },
    policyHash: 'sha256:test',
      snapshot: { tabs: [tab('a')], settings: {} as never, worktrees: {} as never, terminals: { revision: 0, panes: [], openTabIds: [] } as never, automations: [], engine: {} as never, presence: { entries: [], driving: {} } },
    })
    expect(useSessionStore.getState().tabsReady).toBe(true)
    expect(useSessionStore.getState().tabs.map((t) => t.id)).toEqual(['a'])
  })

  it('hydrates tabs from a studio_snapshot frame', () => {
    initTabsSyncFromWire()
    frameHandler?.(LOCAL_ENVIRONMENT_ID, {
      type: 'studio_snapshot',
      snapshot: { tabs: [tab('b')], settings: {} as never, worktrees: {} as never, terminals: { revision: 0, panes: [], openTabIds: [] } as never, automations: [], engine: {} as never, presence: { entries: [], driving: {} } },
    })
    expect(useSessionStore.getState().tabs.map((t) => t.id)).toEqual(['b'])
  })

  it('hydrates tabs from a studio:tabs-sync studio_event frame', () => {
    initTabsSyncFromWire()
    frameHandler?.(LOCAL_ENVIRONMENT_ID, {
      type: 'studio_event', channel: 'studio:tabs-sync', payload: { tabs: [tab('c')] },
    })
    expect(useSessionStore.getState().tabs.map((t) => t.id)).toEqual(['c'])
  })

  it('ignores an unrelated studio_event channel', () => {
    initTabsSyncFromWire()
    frameHandler?.(LOCAL_ENVIRONMENT_ID, { type: 'studio_event', channel: 'ion:settings-changed', payload: {} })
    expect(useSessionStore.getState().tabsReady).toBe(false)
  })
})
