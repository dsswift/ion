import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  markDeepLinkConfirmationReady: vi.fn(),
  markDeepLinkConfirmationUnavailable: vi.fn(),
  resolveDeepLinkConfirmation: vi.fn(),
  rejectAllDeepLinkConfirmations: vi.fn(),
  handleDeepLink: vi.fn(async () => ({ ok: true })),
  markDeepLinksReady: vi.fn(),
}))
vi.mock('../../deeplink/confirm', () => deps)
vi.mock('../../deeplink/dispatch', () => ({ handleDeepLink: deps.handleDeepLink, markDeepLinksReady: deps.markDeepLinksReady }))
vi.mock('../lifecycle-actions', () => ({ isLocalDesktop: (c: { transport?: string; clientKind?: string }) => c.transport === 'local' && c.clientKind === 'desktop' }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { DEEPLINK_ACTIONS } from '../deeplink-actions'
import type { Connection } from '../connection'

const conn = { id: 'c' } as unknown as Connection
const run = (name: string, ...args: unknown[]) => DEEPLINK_ACTIONS[name].handler(conn, args)
beforeEach(() => { for (const fn of Object.values(deps)) fn.mockClear() })

describe('DEEPLINK_ACTIONS', () => {
  it('setConfirmAvailability marks the named owner ready or unavailable and ignores any other payload', async () => {
    expect(await run('deeplink.setConfirmAvailability', { owner: 'studio', available: true })).toEqual({ ok: true, value: null })
    expect(deps.markDeepLinkConfirmationReady).toHaveBeenCalledWith('studio')
    expect(await run('deeplink.setConfirmAvailability', { owner: 'overlay', available: false })).toEqual({ ok: true, value: null })
    expect(deps.markDeepLinkConfirmationUnavailable).toHaveBeenCalledWith('overlay', 'renderer unavailable')

    await run('deeplink.setConfirmAvailability', { owner: 'root', available: true })
    await run('deeplink.setConfirmAvailability', { owner: 'studio', available: 'yes' })
    await run('deeplink.setConfirmAvailability', 'studio')
    expect(deps.markDeepLinkConfirmationReady).toHaveBeenCalledTimes(1)
    expect(deps.markDeepLinkConfirmationUnavailable).toHaveBeenCalledTimes(1)
  })

  it('confirmResult resolves a well-formed answer and drops every malformed one', async () => {
    expect(await run('deeplink.confirmResult', { id: 'r1', owner: 'studio', approved: true, tabId: 'tab-1' })).toEqual({ ok: true, value: null })
    expect(deps.resolveDeepLinkConfirmation).toHaveBeenCalledWith({ id: 'r1', owner: 'studio', approved: true, tabId: 'tab-1' })

    for (const bad of [
      null,
      { owner: 'studio', approved: true },
      { id: 'x'.repeat(129), owner: 'studio', approved: true },
      { id: 'r2', owner: 'nobody', approved: true },
      { id: 'r2', owner: 'studio', approved: 'yes' },
      { id: 'r2', owner: 'studio', approved: false, tabId: '' },
      { id: 'r2', owner: 'studio', approved: false, tabId: 7 },
    ]) {
      expect(await run('deeplink.confirmResult', bad)).toEqual({ ok: true, value: null })
    }
    expect(deps.resolveDeepLinkConfirmation).toHaveBeenCalledTimes(1)
  })

  it('the client verbs are conversations:operate; dispatch, ready and surfaceClosed are the local desktop\'s alone', async () => {
    expect(DEEPLINK_ACTIONS['deeplink.setConfirmAvailability'].requiredScope).toBe('conversations:operate')
    expect(DEEPLINK_ACTIONS['deeplink.confirmResult'].requiredScope).toBe('conversations:operate')
    for (const name of ['deeplink.dispatch', 'deeplink.ready', 'deeplink.surfaceClosed']) {
      expect(DEEPLINK_ACTIONS[name].requiredScope, name).toBe('admin')
      expect(await DEEPLINK_ACTIONS[name].handler({ id: 'w', transport: 'tcp', clientKind: 'web' } as never, ['ion://x'])).toMatchObject({ ok: false, error: { code: 'local_only' } })
    }
  })

  it('dispatch hands the OS url to the dispatcher; ready flushes the queue; surfaceClosed declines what was pending', async () => {
    const desktop = { id: 'd', transport: 'local', clientKind: 'desktop' } as never
    expect(await DEEPLINK_ACTIONS['deeplink.dispatch'].handler(desktop, ['ion://terminal?cmd=ls'])).toEqual({ ok: true, value: { ok: true } })
    expect(deps.handleDeepLink).toHaveBeenCalledWith('ion://terminal?cmd=ls')
    expect(await DEEPLINK_ACTIONS['deeplink.dispatch'].handler(desktop, [''])).toEqual({ ok: true, value: { ok: false, error: 'url required' } })
    await DEEPLINK_ACTIONS['deeplink.ready'].handler(desktop, [])
    expect(deps.markDeepLinksReady).toHaveBeenCalledTimes(1)
    await DEEPLINK_ACTIONS['deeplink.surfaceClosed'].handler(desktop, [{ owner: 'studio' }])
    expect(deps.markDeepLinkConfirmationUnavailable).toHaveBeenCalledWith('studio', 'window closed')
    expect(deps.rejectAllDeepLinkConfirmations).toHaveBeenCalledWith('studio window closed')
  })
})
