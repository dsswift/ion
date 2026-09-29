/**
 * The server decides which Composer Actions each conversation offers. A
 * workspace-wide action reaches every conversation's resource subscription,
 * so the rule under test is the one that keeps an extension's actions out of
 * a conversation that does not run that extension.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn() }))

import { ComposerActionsBoard } from '../composer-actions'
import type { ComposerActionsState } from '@ion/shared/composer-actions'
import type { ResourceItem } from '@ion/shared/types-engine'

const action = (id: string, command: string, conversationId?: string): ResourceItem => ({
  id, kind: 'ion-studio.composer-action', producer: 'cos2', content: JSON.stringify({ label: id, command }), createdAt: '2026-01-01T00:00:00Z', conversationId,
} as ResourceItem)

function board(registry: Record<string, string[]>, conversations: Record<string, string> = {}) {
  const published: ComposerActionsState[] = []
  const b = new ComposerActionsBoard({
    ownedCommands: (key) => (registry[key] ? new Set(registry[key]) : undefined),
    conversationIdOf: (tabId) => conversations[tabId] ?? null,
    publish: (s) => published.push(s),
  })
  return { b, published, registry }
}

describe('ComposerActionsBoard', () => {
  it('offers a workspace-wide action only in the conversation that runs the extension', () => {
    const { b, published } = board({ 'cos-tab': ['briefing', 'dashboard'] })
    const items = [action('briefing', '/briefing'), action('dashboard', '/dashboard')]
    // The broker delivers the same workspace-wide items to both subscriptions.
    b.applySnapshot('cos-tab', items)
    b.applySnapshot('plain-tab', items)
    expect(b.actionsFor('cos-tab').map((a) => a.id)).toEqual(['briefing', 'dashboard'])
    expect(b.actionsFor('plain-tab')).toEqual([])
    expect(published.map((p) => p.tabId)).toEqual(['cos-tab'])
  })

  it('publishes once the command registry arrives, and withdraws when it empties', () => {
    const { b, published, registry } = board({})
    b.applySnapshot('tab-1', [action('briefing', '/briefing')])
    expect(published).toEqual([])
    registry['tab-1'] = ['briefing']
    b.registryChanged('tab-1')
    expect(published.at(-1)).toMatchObject({ tabId: 'tab-1', actions: [{ id: 'briefing', producer: 'cos2' }] })
    delete registry['tab-1']
    b.registryChanged('tab-1')
    expect(published.at(-1)).toEqual({ tabId: 'tab-1', actions: [] })
    expect(b.actionsFor('tab-1')).toEqual([])
  })

  it('offers a conversation-scoped action only in that conversation', () => {
    const { b } = board({}, { 'tab-1': 'conv-1', 'tab-2': 'conv-2' })
    const items = [action('here', '/here', 'conv-1')]
    b.applySnapshot('tab-1', items)
    b.applySnapshot('tab-2', items)
    expect(b.actionsFor('tab-1').map((a) => a.id)).toEqual(['here'])
    expect(b.actionsFor('tab-2')).toEqual([])
  })

  it('applies create and delete deltas, and publishes nothing when the answer is unchanged', () => {
    const { b, published } = board({ 'tab-1': ['briefing'] })
    b.applyDelta('tab-1', { op: 'create', item: action('briefing', '/briefing') } as never)
    b.applyDelta('tab-1', { op: 'update', item: action('briefing', '/briefing') } as never)
    expect(published).toHaveLength(1)
    b.applyDelta('tab-1', { op: 'delete', item: action('briefing', '/briefing') } as never)
    expect(published.at(-1)).toEqual({ tabId: 'tab-1', actions: [] })
  })

  it('forgets a closed tab', () => {
    const { b } = board({ 'tab-1': ['briefing'] })
    b.applySnapshot('tab-1', [action('briefing', '/briefing')])
    b.forgetTab('tab-1')
    expect(b.actionsFor('tab-1')).toEqual([])
  })
})
