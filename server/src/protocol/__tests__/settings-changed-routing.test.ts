/**
 * `ion:settings-changed` reaches the right people.
 *
 * An Environment setting is one value for everyone, so every connection
 * hears it. A setting in one person's overlay is theirs: it reaches their
 * own connections (another window, another machine) and nobody else's. It
 * used to reach everyone, which patched another person's client with a
 * default model, a git mode, or tab groups that were never theirs.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../config/current', () => ({ isSharedTenancy: () => false, unownedTabsVisible: () => false }))
vi.mock('../../store/startup-progress', () => ({ startupReportForAttach: () => null }))

import { attachConnectionToEvents, publishStudioEvent } from '../events'
import type { Connection } from '../connection'

function conn(subject: string) {
  const sent: unknown[] = []
  const c = { id: subject, isClosed: false, view: 'mirror', scopes: [], principal: { subject }, thinDirectories: new Set<string>(), send: (frame: unknown) => { sent.push(frame) } } as unknown as Connection
  return { c, sent }
}

describe('ion:settings-changed routing', () => {
  it("sends an overlay setting to its owner's connections only, without the routing argument", () => {
    const host = conn('local:host')
    const hostSecondWindow = conn('local:host')
    const guest = conn('user:guest')
    const detach = [host, hostSecondWindow, guest].map((x) => attachConnectionToEvents(x.c))

    publishStudioEvent('ion:settings-changed', ['preferredModel', 'model-a', 'local:host'])

    const frame = { type: 'studio_event', channel: 'ion:settings-changed', payload: ['preferredModel', 'model-a'] }
    expect(host.sent).toEqual([frame])
    expect(hostSecondWindow.sent).toEqual([frame])
    expect(guest.sent).toEqual([])
    detach.forEach((d) => d())
  })

  it('sends an Environment setting to every connection', () => {
    const host = conn('local:host')
    const guest = conn('user:guest')
    const detach = [host, guest].map((x) => attachConnectionToEvents(x.c))

    publishStudioEvent('ion:settings-changed', ['inboxAutoSettleDays', 3])

    const frame = { type: 'studio_event', channel: 'ion:settings-changed', payload: ['inboxAutoSettleDays', 3] }
    expect(host.sent).toEqual([frame])
    expect(guest.sent).toEqual([frame])
    detach.forEach((d) => d())
  })
})
