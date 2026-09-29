/**
 * Pins the `engine.*` / `plugin.*` remainder: each verb delegates to the
 * host-api function the store calls, names its tab for ownership, and
 * carries the scope the family declares.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  engineAbortDispatch: vi.fn(async () => undefined),
  engineBranchBefore: vi.fn(async () => undefined),
  engineBroadcastHistory: vi.fn(async () => undefined),
  engineDialogResponse: vi.fn(async () => undefined),
  engineRemapSession: vi.fn(),
  engineStop: vi.fn(async () => undefined),
  engineStopBackgroundTask: vi.fn(async () => ({ ok: true, status: 'stopped' })),
  request: vi.fn(async (cmd: string) => ({ cmd })),
}))
vi.mock('../../store/host-api-engine', () => deps)
vi.mock('../../state', () => ({ engineBridge: { request: deps.request } }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { ENGINE_ACTIONS } from '../engine-actions'
import type { Connection } from '../connection'

const conn = { id: 'c' } as unknown as Connection
const run = (name: string, ...args: unknown[]) => ENGINE_ACTIONS[name].handler(conn, args)
beforeEach(() => { for (const fn of Object.values(deps)) fn.mockClear() })

describe('ENGINE_ACTIONS', () => {
  it('delegates each session verb to host-api-engine with the fields it names', async () => {
    await run('engine.abortDispatch', { key: 't1', dispatchId: 'd1' })
    expect(deps.engineAbortDispatch).toHaveBeenCalledWith('t1', 'd1')
    expect(await run('engine.stopBackgroundTask', { key: 't1', taskId: 'bg' })).toEqual({ ok: true, value: { ok: true, status: 'stopped' } })
    await run('engine.dialogResponse', { key: 't1', dialogId: 'dlg', value: { choice: 1 } })
    expect(deps.engineDialogResponse).toHaveBeenCalledWith('t1', 'dlg', { choice: 1 })
    await run('engine.stop', { key: 't1' })
    expect(deps.engineStop).toHaveBeenCalledWith('t1')
    await run('engine.branchBefore', { key: 't1', entryId: 'e9' })
    expect(deps.engineBranchBefore).toHaveBeenCalledWith('t1', 'e9')
    await run('engine.remapSession', { oldKey: 't1', newKey: 't2' })
    expect(deps.engineRemapSession).toHaveBeenCalledWith('t1', 't2')
    await run('engine.broadcastHistory', { tabId: 't1', instanceId: 'main', opts: { queueUntilTabExists: true } })
    expect(deps.engineBroadcastHistory).toHaveBeenCalledWith('t1', 'main', { queueUntilTabExists: true })
    await run('engine.broadcastHistory', { tabId: 't1' })
    expect(deps.engineBroadcastHistory).toHaveBeenLastCalledWith('t1', null, {})
  })

  it('names the owning tab for every session verb', () => {
    expect(ENGINE_ACTIONS['engine.abortDispatch'].tabIdAt?.([{ key: 't1' }])).toBe('t1')
    expect(ENGINE_ACTIONS['engine.stop'].tabIdAt?.([{ key: '' }])).toBeUndefined()
    expect(ENGINE_ACTIONS['engine.remapSession'].tabIdAt?.([{ oldKey: 'old', newKey: 'new' }])).toBe('old')
    expect(ENGINE_ACTIONS['engine.broadcastHistory'].tabIdAt?.([{ tabId: 't9' }])).toBe('t9')
    for (const name of ['engine.abortDispatch', 'engine.stopBackgroundTask', 'engine.dialogResponse', 'engine.stop', 'engine.branchBefore', 'engine.remapSession', 'engine.broadcastHistory']) {
      expect(ENGINE_ACTIONS[name].requiredScope, name).toBe('conversations:operate')
    }
  })

  it('a thrown delegate becomes a failed action, not an unhandled rejection', async () => {
    deps.engineBranchBefore.mockRejectedValueOnce(new Error('unknown entry'))
    expect(await run('engine.branchBefore', { key: 't1', entryId: 'nope' })).toEqual({ ok: false, error: { code: 'action_failed', message: 'Error: unknown entry' } })
  })

  it('plugin verbs are admin and go straight to the engine request channel', async () => {
    expect(await run('plugin.install', 'github:acme/plugin')).toEqual({ ok: true, value: { cmd: 'plugin_install' } })
    expect(deps.request).toHaveBeenCalledWith('plugin_install', { source: 'github:acme/plugin' })
    await run('plugin.list')
    expect(deps.request).toHaveBeenCalledWith('plugin_list', {})
    await run('plugin.remove', 'acme')
    expect(deps.request).toHaveBeenCalledWith('plugin_remove', { label: 'acme' })
    for (const name of ['plugin.install', 'plugin.list', 'plugin.remove']) expect(ENGINE_ACTIONS[name].requiredScope, name).toBe('admin')
  })
})
