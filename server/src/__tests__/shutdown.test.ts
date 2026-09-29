import { describe, expect, it, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => ({ order: [] as string[] }))
const deps = vi.hoisted(() => ({
  sessionShutdown: vi.fn((opts: { stopSessions: boolean }) => { calls.order.push(`sessions:${opts.stopSessions}`) }),
  forceFlushTabs: vi.fn(() => { calls.order.push('flush') }),
  saveStudioTerminals: vi.fn(() => { calls.order.push('save-terminals') }),
  destroyAll: vi.fn(() => { calls.order.push('destroy-terminals') }),
  stopTabSnapshotPolling: vi.fn(() => { calls.order.push('snapshot-poll') }),
  stopWorktreeFreshnessPoll: vi.fn(() => { calls.order.push('freshness') }),
  stopGitWatcherBridge: vi.fn(() => { calls.order.push('git-bridge') }),
  stopStructuralSnapshotFeed: vi.fn(() => { calls.order.push('feed') }),
  stopWatchdog: vi.fn(() => { calls.order.push('watchdog') }),
  flushLogs: vi.fn(() => { calls.order.push('flush-logs') }),
  closeEgress: vi.fn(async () => { calls.order.push('close-egress') }),
}))
vi.mock('../state', () => ({ state: {}, sessionPlane: { shutdown: deps.sessionShutdown } }))
vi.mock('../store/session-store-force-flush', () => ({ forceFlushTabs: deps.forceFlushTabs }))
vi.mock('../persistence/studio-terminal-persistence', () => ({ saveStudioTerminals: deps.saveStudioTerminals }))
vi.mock('../terminal/terminal-manager-instance', () => ({ terminalManager: { destroyAll: deps.destroyAll } }))
vi.mock('../remote/snapshot-polling', () => ({ stopTabSnapshotPolling: deps.stopTabSnapshotPolling }))
vi.mock('../worktree/freshness-poll', () => ({ stopWorktreeFreshnessPoll: deps.stopWorktreeFreshnessPoll }))
vi.mock('../remote/git-watcher-bridge', () => ({ stopGitWatcherBridge: deps.stopGitWatcherBridge }))
vi.mock('../remote/structural-poll', () => ({ stopStructuralSnapshotFeed: deps.stopStructuralSnapshotFeed }))
vi.mock('../watchdog', () => ({ stopWatchdog: deps.stopWatchdog }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), flushLogs: deps.flushLogs }))
vi.mock('@ion/shared/log-egress', () => ({ closeEgress: deps.closeEgress }))

import { runServerShutdown, setShutdownHandle, _resetShutdownForTest } from '../shutdown'

beforeEach(() => {
  calls.order.length = 0
  for (const fn of Object.values(deps)) if (typeof fn === 'function' && 'mockClear' in fn) (fn as ReturnType<typeof vi.fn>).mockClear()
  deps.forceFlushTabs.mockImplementation(() => { calls.order.push('flush') })
  _resetShutdownForTest()
})

describe('runServerShutdown', () => {
  it('persists first, stops every background job, then the session plane, then the listeners', async () => {
    const close = vi.fn(async () => { calls.order.push('close') })
    setShutdownHandle({ close })
    await runServerShutdown({ stopSessions: false, reason: 'test' })
    expect(calls.order).toEqual([
      'flush', 'save-terminals', 'destroy-terminals', 'snapshot-poll', 'feed', 'freshness', 'git-bridge', 'watchdog',
      'sessions:false', 'close', 'flush-logs', 'close-egress',
    ])
  })

  it('stopSessions reaches the session plane unchanged', async () => {
    await runServerShutdown({ stopSessions: true, reason: 'quit-all' })
    expect(deps.sessionShutdown).toHaveBeenCalledWith({ stopSessions: true })
  })

  it('runs once: a second request joins the first', async () => {
    const first = runServerShutdown({ stopSessions: false, reason: 'a' })
    const second = runServerShutdown({ stopSessions: true, reason: 'b' })
    expect(second).toBe(first)
    await first
    expect(deps.sessionShutdown).toHaveBeenCalledTimes(1)
  })

  it('a throwing step never stops the rest', async () => {
    deps.forceFlushTabs.mockImplementation(() => { throw new Error('disk full') })
    await runServerShutdown({ stopSessions: false, reason: 'test' })
    expect(deps.destroyAll).toHaveBeenCalled()
    expect(deps.stopWatchdog).toHaveBeenCalled()
    expect(deps.sessionShutdown).toHaveBeenCalled()
  })

  it('drains the log buffer and the egress sink last, after the final line is written', async () => {
    // Every caller exits as soon as this resolves, and the logger holds
    // non-ERROR lines for up to 500ms. Without this step 'shutdown complete'
    // and the step lines that explain a slow or failed quit died in the
    // buffer, so a quit that went wrong left a log that stopped mid-sequence.
    await runServerShutdown({ stopSessions: false, reason: 'drain' })
    expect(deps.flushLogs).toHaveBeenCalledOnce()
    expect(deps.closeEgress).toHaveBeenCalledOnce()
    expect(calls.order.slice(-2)).toEqual(['flush-logs', 'close-egress'])
  })
})
