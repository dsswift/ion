// @vitest-environment jsdom
/**
 * NotificationsPage — the kind list is every workspace-scoped kind seen plus
 * every hidden kind; conversation-only kinds never appear; a switch writes
 * the sorted blocklist; an empty list explains itself.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness, type Harness } from './page-harness'

const session = vi.hoisted(() => ({ resources: {} as Record<string, Array<{ conversationId?: string }>> }))
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: (sel: (s: typeof session) => unknown) => sel(session) }))
vi.mock('../../settings-target', async () => {
  const { create } = await import('zustand')
  return { useSettingsPreferences: create<Record<string, unknown>>(() => ({})) }
})

const { useSettingsPreferences } = await import('../../settings-target')
const { NotificationsPage } = await import('../NotificationsPage')
const setExcludedResourceKinds = vi.fn()

let h: Harness
beforeEach(() => {
  setExcludedResourceKinds.mockReset()
  ;(useSettingsPreferences as unknown as { setState(s: object, replace: boolean): void }).setState({ excludedResourceKinds: ['zeta'], setExcludedResourceKinds }, true)
  h = createHarness()
})
afterEach(() => h.unmount())

describe('NotificationsPage', () => {
  it('lists observed workspace kinds and hidden kinds, sorted, never conversation-only kinds', async () => {
    session.resources = { briefing: [{}], review: [{ conversationId: 'c1' }, {}], plan: [{ conversationId: 'c2' }] }
    await h.render(<NotificationsPage />)
    const rows = [...h.container.querySelectorAll('[role="listitem"]')].map((r) => r.textContent)
    expect(rows).toEqual(['briefing', 'review', 'zeta'])
    expect(h.control('Show "zeta" resources in the global notification tray').getAttribute('aria-checked')).toBe('false')
    expect(h.control('Show "briefing" resources in the global notification tray').getAttribute('aria-checked')).toBe('true')
  })

  it('hiding and showing a kind writes the sorted blocklist', async () => {
    session.resources = { briefing: [{}] }
    await h.render(<NotificationsPage />)
    await h.click('Show "briefing" resources in the global notification tray')
    expect(setExcludedResourceKinds).toHaveBeenLastCalledWith(['briefing', 'zeta'])
    await h.click('Show "zeta" resources in the global notification tray')
    expect(setExcludedResourceKinds).toHaveBeenLastCalledWith([])
  })

  it('explains an empty list', async () => {
    session.resources = {}
    ;(useSettingsPreferences as unknown as { setState(s: object): void }).setState({ excludedResourceKinds: [] })
    await h.render(<NotificationsPage />)
    expect(h.container.textContent).toContain('No notification kinds yet')
  })
})
