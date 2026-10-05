/**
 * The remote `deeplink.open` flow. The property that matters: nothing a
 * remote link asks for runs until the same connection approves it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  navigate: vi.fn(),
  resolveExt: vi.fn(),
  ownsConversation: vi.fn(),
  ownsTab: vi.fn(),
}))

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../execute', () => ({ executeDeepLinkAction: (...a: any[]) => mocks.execute(...a) }))
vi.mock('../navigate', () => ({ resolveNavigation: (...a: any[]) => mocks.navigate(...a) }))
vi.mock('../action-ext', () => ({ resolveExt: (...a: any[]) => mocks.resolveExt(...a) }))
vi.mock('../../protocol/ownership', () => ({
  connOwnsConversation: (...a: any[]) => mocks.ownsConversation(...a),
  connOwnsTab: (...a: any[]) => mocks.ownsTab(...a),
}))

import { openDeepLinkForConnection, resetRemoteDeepLinksForTests, settleRemoteConfirmation } from '../remote'
import type { Connection } from '../../protocol/connection'

/** A connection signed in as `subject`; only the fields the flow reads. */
function conn(id: string, subject = 'alice'): Connection {
  return { id, principal: { subject } } as unknown as Connection
}
const phone = conn('phone')

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteDeepLinksForTests()
  mocks.execute.mockResolvedValue({ ok: true, tabId: 'tab-9' })
  mocks.ownsConversation.mockReturnValue(true)
  mocks.ownsTab.mockReturnValue(true)
})

describe('openDeepLinkForConnection', () => {
  it('returns a confirmation for an action link and runs nothing', async () => {
    const r = await openDeepLinkForConnection(phone, 'ion://prompt?dir=/repo&text=hello')
    expect(r.kind).toBe('confirm')
    if (r.kind !== 'confirm') return
    expect(r.request).toMatchObject({ owner: 'remote', action: 'prompt', text: 'hello', dir: '/repo' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('ignores a capability token: a remote action always asks', async () => {
    const r = await openDeepLinkForConnection(phone, 'ion://prompt?dir=/repo&text=hi&token=deadbeef')
    expect(r.kind).toBe('confirm')
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('refuses a handoff link, whose payload only exists on this host', async () => {
    const r = await openDeepLinkForConnection(phone, 'ion://prompt?req=123e4567-e89b-12d3-a456-426614174000')
    expect(r).toMatchObject({ kind: 'error' })
  })

  it('refuses a terminal link that names no conversation', async () => {
    const r = await openDeepLinkForConnection(phone, 'ion://terminal?cmd=ls')
    expect(r).toMatchObject({ kind: 'error' })
  })

  it('answers a navigation link with its target', async () => {
    mocks.navigate.mockResolvedValue({ ok: true, target: { route: 'settings', panel: 'git-access', pageId: 'git-access', projectable: false } })
    const r = await openDeepLinkForConnection(phone, 'ion://settings?panel=git-access')
    expect(r).toEqual({ kind: 'navigate', target: { route: 'settings', panel: 'git-access', pageId: 'git-access', projectable: false } })
  })

  it('shows the resolved command for an ext link', async () => {
    mocks.resolveExt.mockReturnValue({ ok: true, ext: { label: 'Triage', command: '/triage 42' } })
    const r = await openDeepLinkForConnection(phone, 'ion://ext/triage?args=42&dir=/repo')
    expect(r.kind === 'confirm' && r.request).toMatchObject({ action: 'ext', routeId: 'triage', label: 'Triage', command: '/triage 42' })
  })
})

describe('settleRemoteConfirmation', () => {
  async function pendingId(): Promise<string> {
    const r = await openDeepLinkForConnection(phone, 'ion://prompt?dir=/repo&text=hello')
    if (r.kind !== 'confirm') throw new Error('expected a confirmation')
    return r.id
  }

  it('returns null for an id that is not a remote one', async () => {
    expect(await settleRemoteConfirmation(phone, 'dl-1-2', true)).toBeNull()
  })

  it('refuses an answer from a different connection and runs nothing', async () => {
    const id = await pendingId()
    const out = await settleRemoteConfirmation(conn('someone-else'), id, true)
    expect(out).toMatchObject({ ok: false })
    expect(mocks.execute).not.toHaveBeenCalled()
    // The rightful connection can still answer it.
    expect(await settleRemoteConfirmation(phone, id, true)).toEqual({ ok: true, error: undefined, tabId: 'tab-9' })
  })

  it('runs the action once on approval', async () => {
    const id = await pendingId()
    await settleRemoteConfirmation(phone, id, true)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.execute.mock.calls[0][0]).toMatchObject({ action: 'prompt', text: 'hello' })
    // A second answer finds nothing to run.
    expect(await settleRemoteConfirmation(phone, id, true)).toMatchObject({ ok: false })
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })

  it('declining runs nothing', async () => {
    const id = await pendingId()
    expect(await settleRemoteConfirmation(phone, id, false)).toEqual({ ok: false, error: 'declined' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
})

// A remote client may only reach conversations and tabs its principal owns
// (ADR-034). The check runs at open and again at approval.
describe('ownership', () => {
  it('refuses a conversation link to a conversation the caller does not own', async () => {
    mocks.ownsConversation.mockImplementation((_c: Connection, id: string) => id !== 'bobs-conv')
    const r = await openDeepLinkForConnection(phone, 'ion://conversation?id=bobs-conv')
    expect(r).toMatchObject({ kind: 'error' })
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('refuses an ext link that targets a conversation the caller does not own', async () => {
    mocks.ownsConversation.mockReturnValue(false)
    mocks.resolveExt.mockReturnValue({ ok: true, ext: { label: 'Triage', command: '/triage' } })
    const r = await openDeepLinkForConnection(phone, 'ion://ext/triage?conversation=bobs-conv')
    expect(r).toMatchObject({ kind: 'error' })
    expect(mocks.resolveExt).not.toHaveBeenCalled()
  })

  it('refuses a terminal link that targets a tab the caller does not own', async () => {
    mocks.ownsTab.mockReturnValue(false)
    const r = await openDeepLinkForConnection(phone, 'ion://terminal?tabId=bobs-tab&cmd=ls')
    expect(r).toMatchObject({ kind: 'error' })
  })

  it('lets the owner through', async () => {
    mocks.navigate.mockResolvedValue({ ok: true, target: { route: 'conversation', conversationId: 'mine', tabId: 't1' } })
    const r = await openDeepLinkForConnection(phone, 'ion://conversation?id=mine')
    expect(r).toMatchObject({ kind: 'navigate' })
    expect(mocks.ownsConversation).toHaveBeenCalledWith(phone, 'mine')
  })

  it('checks again at approval and runs nothing when access was lost', async () => {
    const r = await openDeepLinkForConnection(phone, 'ion://terminal?tabId=t1&cmd=ls')
    if (r.kind !== 'confirm') throw new Error('expected a confirmation')
    mocks.ownsTab.mockReturnValue(false)
    expect(await settleRemoteConfirmation(phone, r.id, true)).toMatchObject({ ok: false })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
})
