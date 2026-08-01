/**
 * atv:call-action — the mirror→owner round trip in the main process.
 *
 * The ATV window runs the session store in MIRROR mode, so owner-durable
 * actions execute in the overlay renderer. A mirror caller that inspects the
 * result (`const result = await store.retireWorktree(…)`) needs the owner's real
 * return value, so main mints a correlation id, relays the action, and resolves
 * when the owner replies.
 *
 * The paths that matter here are the ones a renderer cannot recover from:
 * an unvalidated action, a missing owner window, and an owner that never
 * replies. Each must produce a RESOLVED refusal — a mirror caller awaiting the
 * promise would otherwise hang forever, which is strictly worse than the
 * TypeError this whole mechanism replaced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** Captured ipcMain registrations, so a test can invoke a handler directly. */
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const onListeners = new Map<string, Array<(...args: unknown[]) => void>>()
const sent: Array<{ channel: string; args: unknown[] }> = []

/** webContents.id of the mocked owner window; replies must carry it. */
const OWNER_SENDER_ID = 1

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  ownerDestroyed: { value: false },
  ownerPresent: { value: true },
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0') },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
    on: (channel: string, fn: (...args: unknown[]) => void) => {
      const list = onListeners.get(channel) ?? []
      list.push(fn)
      onListeners.set(channel, list)
    },
    removeListener: (channel: string, fn: (...args: unknown[]) => void) => {
      const list = (onListeners.get(channel) ?? []).filter((f) => f !== fn)
      onListeners.set(channel, list)
    },
  },
}))

vi.mock('../state', () => ({
  state: {
    get mainWindow() {
      if (!mocks.ownerPresent.value) return null
      return {
        isDestroyed: () => mocks.ownerDestroyed.value,
        webContents: {
          id: OWNER_SENDER_ID,
          send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
        },
      }
    },
    atvActiveTabId: null,
    atvActiveProfileId: null,
  },
}))

vi.mock('../logger', () => ({ log: mocks.log }))
vi.mock('../atv-window-manager', () => ({
  openAtvWindow: vi.fn(), applyAtvActivationPolicy: vi.fn(), isAtvWindowOpen: vi.fn(() => false),
}))
vi.mock('../window-manager', () => ({ showWindow: vi.fn() }))
vi.mock('../atv-state-cache', () => ({ getAtvState: vi.fn(() => null), allAtvSummaries: vi.fn(() => []) }))
vi.mock('../atv-theme-packs', () => ({
  listThemePacks: vi.fn(() => []), readPackBundle: vi.fn(), readThemeAsset: vi.fn(),
}))
vi.mock('../remote/snapshot', () => ({ getRemoteTabStates: vi.fn(() => []) }))
vi.mock('../settings-store', () => ({
  readSettings: vi.fn(() => ({})), writeSettings: vi.fn(), SETTINGS_DEFAULTS: {},
}))

import { IPC } from '../../shared/types'
import { registerAtvIpc } from '../ipc/atv'

/** Drive a reply for a relayed call, as an arbitrary sender. */
function replyAs(senderId: number, callId: string, value: unknown): void {
  const event = { sender: { id: senderId } }
  for (const fn of onListeners.get(IPC.ATV_ACTION_RESULT) ?? []) fn(event, callId, value)
}

/** Drive the OWNER's reply for a relayed call. */
function replyAsOwner(callId: string, value: unknown): void {
  replyAs(OWNER_SENDER_ID, callId, value)
}

function callAction(action: unknown, args: unknown): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const handler = handlers.get(IPC.ATV_CALL_ACTION)
  if (!handler) throw new Error('ATV_CALL_ACTION handler not registered')
  return handler({}, action, args) as Promise<{ ok: boolean; value?: unknown; error?: string }>
}

describe('atv:call-action round trip', () => {
  beforeEach(() => {
    handlers.clear()
    onListeners.clear()
    sent.length = 0
    mocks.log.mockClear()
    mocks.ownerPresent.value = true
    mocks.ownerDestroyed.value = false
    registerAtvIpc()
  })

  afterEach(() => { vi.useRealTimers() })

  it("relays a validated action and resolves the owner's return value", async () => {
    const pending = callAction('retireWorktree', ['/repo', '/repo/wt', 'branch'])

    // Relayed to the owner with a correlation id appended.
    const relayed = sent.find((s) => s.channel === IPC.ATV_EXEC_ACTION)
    expect(relayed).toBeDefined()
    expect(relayed!.args[0]).toBe('retireWorktree')
    const callId = relayed!.args[2] as string
    expect(typeof callId).toBe('string')

    const ownerValue = { ok: false, error: 'uncommitted changes' }
    replyAsOwner(callId, ownerValue)

    // ok describes the ROUND TRIP; the domain result rides in `value` intact,
    // so a refusal stays distinguishable from a transport fault.
    await expect(pending).resolves.toEqual({ ok: true, value: ownerValue })
  })

  it('ignores a reply carrying a different callId', async () => {
    vi.useFakeTimers()
    const pending = callAction('selectTab', ['tab-1'])
    const callId = (sent.find((s) => s.channel === IPC.ATV_EXEC_ACTION)!.args[2] as string)

    // A concurrent call's reply must not settle this one.
    replyAsOwner(`${callId}-someone-else`, { ok: true })
    await vi.advanceTimersByTimeAsync(30_000)

    // Still timed out rather than resolving with the wrong answer.
    await expect(pending).resolves.toEqual({ ok: false, error: 'owner did not reply' })
  })

  it('rejects an action outside FORWARDED_ACTIONS without relaying', async () => {
    // handleNormalizedEvent is MIRROR_LOCAL — forwarding it would let the ATV
    // drive owner state through a channel that skips the classification.
    await expect(callAction('handleNormalizedEvent', ['tab-1', {}]))
      .resolves.toEqual({ ok: false, error: 'action not permitted' })
    expect(sent.filter((s) => s.channel === IPC.ATV_EXEC_ACTION)).toHaveLength(0)
  })

  it('rejects a well-named action with bad arity without relaying', async () => {
    await expect(callAction('selectTab', [])).resolves.toEqual({ ok: false, error: 'action not permitted' })
    expect(sent.filter((s) => s.channel === IPC.ATV_EXEC_ACTION)).toHaveLength(0)
  })

  it('resolves a refusal when no owner window exists', async () => {
    mocks.ownerPresent.value = false
    await expect(callAction('selectTab', ['tab-1']))
      .resolves.toEqual({ ok: false, error: 'no owner window' })
  })

  it('resolves a refusal when the owner window is destroyed', async () => {
    mocks.ownerDestroyed.value = true
    await expect(callAction('selectTab', ['tab-1']))
      .resolves.toEqual({ ok: false, error: 'no owner window' })
  })

  it('resolves a refusal when the owner never replies', async () => {
    vi.useFakeTimers()
    const pending = callAction('selectTab', ['tab-1'])
    await vi.advanceTimersByTimeAsync(30_000)
    // The whole point: a wedged owner must not leave the mirror caller pending.
    await expect(pending).resolves.toEqual({ ok: false, error: 'owner did not reply' })
  })

  it('leaves no reply listener behind on either path', async () => {
    vi.useFakeTimers()
    const before = (onListeners.get(IPC.ATV_ACTION_RESULT) ?? []).length

    // Replied path: released immediately.
    const replied = callAction('selectTab', ['tab-1'])
    replyAsOwner(sent.at(-1)!.args[2] as string, undefined)
    await replied
    expect((onListeners.get(IPC.ATV_ACTION_RESULT) ?? []).length).toBe(before)

    // Timed-out path: the listener lingers for the late-reply grace window so a
    // reply that just missed the deadline can still be logged, then releases.
    const timedOut = callAction('selectTab', ['tab-2'])
    await vi.advanceTimersByTimeAsync(30_000)
    await timedOut
    await vi.advanceTimersByTimeAsync(10_000)

    // A listener leak here would accumulate one dead handler per forwarded
    // call for the life of the process.
    expect((onListeners.get(IPC.ATV_ACTION_RESULT) ?? []).length).toBe(before)
  })

  /**
   * A reply for a LIVE callId from a renderer other than the owner window must
   * not settle the call.
   *
   * ATV_ACTION_RESULT is an ipcMain.on listener, so any renderer holding the
   * preload bridge can send on it, and the callId is a predictable counter
   * (`atv-call-N`). Without the sender check a non-owner window could hand the
   * mirror a fabricated `{ ok: true }` and a refused retire would read as
   * succeeded. Red on revert: drop the `event.sender.id !== ownerSenderId`
   * guard and this resolves with the forged value instead of timing out.
   */
  it('refuses a reply from a sender that is not the owner window', async () => {
    vi.useFakeTimers()
    const pending = callAction('retireWorktree', ['/repo', '/repo/wt', 'branch'])
    const callId = sent.find((s) => s.channel === IPC.ATV_EXEC_ACTION)!.args[2] as string

    // An impostor renderer answers first with a forged success.
    replyAs(OWNER_SENDER_ID + 99, callId, { ok: true, forged: true })
    await vi.advanceTimersByTimeAsync(30_000)

    // The forged value never reached the caller.
    await expect(pending).resolves.toEqual({ ok: false, error: 'owner did not reply' })
  })

  /**
   * The real owner's reply still lands after an impostor was refused — the
   * guard rejects the wrong sender without consuming the pending call.
   */
  it('still accepts the owner reply after refusing an impostor', async () => {
    const pending = callAction('retireWorktree', ['/repo', '/repo/wt', 'branch'])
    const callId = sent.find((s) => s.channel === IPC.ATV_EXEC_ACTION)!.args[2] as string

    replyAs(OWNER_SENDER_ID + 99, callId, { ok: true, forged: true })
    replyAsOwner(callId, { ok: false, error: 'uncommitted changes' })

    await expect(pending).resolves.toEqual({
      ok: true, value: { ok: false, error: 'uncommitted changes' },
    })
  })

  /**
   * A reply that arrives after the deadline is logged rather than silently
   * dropped: it means the timeout is too tight for that action, which is
   * otherwise indistinguishable in the log from an owner that never answered.
   */
  it('logs a reply that arrives after the timeout', async () => {
    vi.useFakeTimers()
    const pending = callAction('selectTab', ['tab-1'])
    const callId = sent.find((s) => s.channel === IPC.ATV_EXEC_ACTION)!.args[2] as string

    await vi.advanceTimersByTimeAsync(30_000)
    await pending

    mocks.log.mockClear()
    replyAsOwner(callId, { late: true })

    // The module's log() wrapper calls _log('atv', msg, fields), so the message
    // is the SECOND argument.
    const logged = mocks.log.mock.calls.some(
      ([, msg]) => typeof msg === 'string' && msg.includes('after timeout'),
    )
    expect(logged, 'a late reply must be observable in the log').toBe(true)
  })
})
