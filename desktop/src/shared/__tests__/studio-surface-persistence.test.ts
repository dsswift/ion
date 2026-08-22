import { describe, expect, it } from 'vitest'
import { emptySurfacePersisted, parseSurfacePersisted, serializeSurface, validateSurfacePersisted } from '../studio-surface-persistence'
import type { SurfaceConversationPersisted, SurfaceTab } from '../studio-surface-types'

const tabs: SurfaceTab[] = [
  { kind: 'singleton', id: 'diff' },
  { kind: 'file', id: 'file:/repo/a.ts', filePath: '/repo/a.ts', dir: '/repo' },
  { kind: 'browser', id: 'browser:b1', instanceId: 'b1', url: 'https://example.org', title: 'Example', mode: 'browse' },
]
const conversation: SurfaceConversationPersisted = { tabs, activeTabId: 'file:/repo/a.ts', visible: true }

describe('surface persistence', () => {
  it('defaults Plan as the only global pin', () => {
    expect(emptySurfacePersisted()).toEqual({ version: 2, pinnedTabs: ['plan'], notification: null, conversations: {} })
  })

  it('round-trips conversation records and global pins', () => {
    const persisted = serializeSurface(['diff', 'plan'], null, { alpha: conversation })
    const parsed = parseSurfacePersisted(JSON.parse(JSON.stringify(persisted)))
    expect(parsed).toEqual(persisted)
    expect(validateSurfacePersisted(persisted)).toBe(true)
  })

  it('drops malformed conversation records and invalid pins', () => {
    const parsed = parseSurfacePersisted({ version: 2, pinnedTabs: ['plan', 'files', 'plan'], conversations: { valid: conversation, broken: { tabs: [] } } })
    expect(parsed).toMatchObject({ version: 2, pinnedTabs: ['plan'] })
    expect((parsed as { conversations: Record<string, unknown> }).conversations).toHaveProperty('valid')
    expect((parsed as { conversations: Record<string, unknown> }).conversations).not.toHaveProperty('broken')
  })

  it('reads v1 only for migration and rejects it as a new write', () => {
    const legacy = parseSurfacePersisted({ version: 1, tabs, activeTabId: 'diff' })
    expect(legacy).toMatchObject({ version: 1, activeTabId: 'diff' })
    expect(validateSurfacePersisted({ version: 1, tabs, activeTabId: 'diff' })).toBe(false)
  })

  it('preserves the global notification and excludes it from local records', () => {
    const notification = { kind: 'notification' as const, id: 'notification' as const, resourceKind: 'x', resourceId: 'y' }
    const persisted = serializeSurface(['plan'], notification, { alpha: { tabs: [...tabs, notification, { kind: 'runtime-panel', id: 'runtime:x', title: 'X' }], activeTabId: 'notification', visible: false } })
    expect(persisted.notification).toEqual(notification)
    expect(persisted.conversations.alpha?.tabs.map((tab) => tab.kind)).not.toContain('notification')
    expect(persisted.conversations.alpha?.tabs.map((tab) => tab.kind)).not.toContain('runtime-panel')
  })
})
