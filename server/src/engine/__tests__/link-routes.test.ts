import { describe, it, expect, vi } from 'vitest'
import type { ResourceItem } from '@ion/shared/types-engine'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { LinkRoutesBoard } from '../link-routes'

function route(id: string, command: string, conversationId?: string): ResourceItem {
  return {
    id, kind: 'ion-studio.link-route', producer: 'ext-a', title: id, createdAt: '2026-01-01T00:00:00Z',
    content: JSON.stringify({ label: id, command }),
    ...(conversationId ? { conversationId } : {}),
  } as ResourceItem
}

function board(owned: Record<string, string[]>): LinkRoutesBoard {
  return new LinkRoutesBoard({ ownedCommands: (key) => (owned[key] ? new Set(owned[key]) : undefined) })
}

describe('LinkRoutesBoard', () => {
  it('offers a workspace route only where the conversation owns its command', () => {
    const b = board({ 'tab-1': ['triage'] })
    b.applySnapshot('tab-1', [route('triage', '/triage')])
    b.applySnapshot('tab-2', [route('triage', '/triage')])
    expect(b.resolve('triage', { tabId: 'tab-1', conversationId: 'c1' })?.route.command).toBe('/triage')
    expect(b.resolve('triage', { tabId: 'tab-2', conversationId: 'c2' })).toBeNull()
  })

  it('offers a conversation-scoped route only to that conversation', () => {
    const b = board({})
    b.applySnapshot('tab-1', [route('mine', '/mine', 'c1')])
    expect(b.resolve('mine', { tabId: 'tab-1', conversationId: 'c1' })).not.toBeNull()
    expect(b.resolve('mine', { tabId: 'tab-1', conversationId: 'c-other' })).toBeNull()
    expect(b.resolve('mine', null)).toBeNull()
  })

  it('resolves a workspace route for a link that opens a new conversation', () => {
    const b = board({})
    b.applySnapshot('tab-1', [route('triage', '/triage')])
    expect(b.resolve('triage', null)?.route.id).toBe('triage')
  })

  it('applies deletes and forgets a closed tab', () => {
    const b = board({ 'tab-1': ['triage'] })
    const item = route('triage', '/triage')
    b.applySnapshot('tab-1', [item])
    b.applyDelta('tab-1', { op: 'delete', item } as any)
    expect(b.resolve('triage', null)).toBeNull()
    b.applyDelta('tab-1', { op: 'create', item } as any)
    b.forgetTab('tab-1')
    expect(b.resolve('triage', null)).toBeNull()
  })

  it('ignores a malformed route', () => {
    const b = board({})
    b.applySnapshot('tab-1', [{ ...route('bad', 'not-a-slash-command') }])
    expect(b.resolve('bad', null)).toBeNull()
  })
})
