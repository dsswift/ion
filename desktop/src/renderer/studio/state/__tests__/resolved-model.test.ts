// @vitest-environment jsdom
/**
 * A conversation names the model its SERVER resolved, never a default of this
 * client's own.
 *
 * The bug this pins: a conversation on another server showed this client's
 * local default model in the picker, the context ring, the thinking picker,
 * and the status drawer, while it actually ran that server's default. Every
 * one of those surfaces now reads the instance through the two selectors
 * below, and the instance carries what the server published.
 */
import { describe, it, expect } from 'vitest'
import { applyResolvedModels, mergePanes, tabsFromSnapshot } from '../hydrate-tabs'
import { runningConversationModel, selectedConversationModel } from '@ion/shared/conversation-model'
import type { PersistedTabState } from '@ion/shared/types'

function snapshot(): PersistedTabState {
  return {
    schemaVersion: 3,
    activeSessionId: null,
    activeTabIndex: 0,
    tabs: [{
      id: 'remote-tab', conversationId: 'c1', title: 'Remote', customTitle: null,
      workingDirectory: '/w', hasChosenDirectory: true, additionalDirs: [],
      conversationPane: { activeInstanceId: 'main', instances: [{ id: 'main', messageCount: 0 }] },
    }],
  } as unknown as PersistedTabState
}

describe('server-resolved model on the mirror', () => {
  it('stamps the published model onto a new pane', () => {
    const snap = snapshot()
    const { tabs } = tabsFromSnapshot(snap, undefined, [], undefined, undefined, 'env-remote')
    const panes = mergePanes(new Map(), snap, tabs, { 'remote-tab': { main: 'acme-gateway/claude-sonnet-5' } })
    const main = panes.get('remote-tab')!.instances[0]
    expect(main.resolvedModel).toBe('acme-gateway/claude-sonnet-5')
    expect(selectedConversationModel(main)).toBe('acme-gateway/claude-sonnet-5')
    expect(runningConversationModel(main)).toBe('acme-gateway/claude-sonnet-5')
  })

  it('updates a kept pane when the server republishes, and keeps identity when nothing changed', () => {
    const snap = snapshot()
    const { tabs } = tabsFromSnapshot(snap, undefined, [], undefined, undefined, 'env-remote')
    const first = mergePanes(new Map(), snap, tabs, { 'remote-tab': { main: 'model-a' } })
    const second = mergePanes(first, snap, tabs, { 'remote-tab': { main: 'model-b' } })
    expect(second.get('remote-tab')!.instances[0].resolvedModel).toBe('model-b')
    const pane = second.get('remote-tab')!
    expect(applyResolvedModels(pane, { main: 'model-b' })).toBe(pane)
  })

  it('keeps the last published model when a sync carries no map', () => {
    const snap = snapshot()
    const { tabs } = tabsFromSnapshot(snap, undefined, [], undefined, undefined, 'env-remote')
    const first = mergePanes(new Map(), snap, tabs, { 'remote-tab': { main: 'model-a' } })
    const second = mergePanes(first, snap, tabs)
    expect(second.get('remote-tab')!.instances[0].resolvedModel).toBe('model-a')
  })

  it('names nothing, rather than a local default, before the server has spoken', () => {
    expect(selectedConversationModel({ modelOverride: null, sessionModel: null })).toBe('')
    expect(runningConversationModel(undefined)).toBe('')
  })

  it('lets the engine-reported model size the context ring before a default', () => {
    expect(runningConversationModel({ modelOverride: null, sessionModel: 'ran-this', resolvedModel: 'default' })).toBe('ran-this')
    expect(selectedConversationModel({ modelOverride: null, sessionModel: 'ran-this', resolvedModel: 'default' })).toBe('default')
  })
})
