/**
 * SDK async-trigger runtime regression tests.
 *
 * Covers engine/extensions/sdk/ion-sdk/runtime-async.ts — the webhook and
 * schedule registration runtime. This is the first test for that file; it was
 * previously untested, which is how the `concurrency`-drop bug (#226) shipped.
 *
 * The runtime holds module-scope registries and an `initResolved` flag, so each
 * test re-imports the module fresh via vi.resetModules() + dynamic import to get
 * a clean registry. A fake RPC bridge captures the (method, params) pairs the
 * runtime sends so we can assert exactly what crosses the wire.
 *
 * This test reaches across the repo boundary into engine/extensions/sdk the same
 * way contract-sync.test.ts reaches into engine/internal/types. vitest transforms
 * the imported .ts regardless of desktop's tsconfig include scope.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

type RpcCall = { method: string; params: any }

// Load a fresh copy of the runtime module with a fake RPC bridge wired in.
// Returns the module exports plus the captured-call array. Each call to this
// helper resets module state so registries/initResolved start clean.
//
// The import specifier must be a string literal (not a variable) so vite can
// statically resolve it relative to this file; a computed specifier resolves
// against the project root and fails. vi.resetModules() still gives each call a
// fresh module instance despite the literal path.
async function freshRuntime(): Promise<{
  mod: typeof import('../../../../engine/extensions/sdk/ion-sdk/runtime-async')
  calls: RpcCall[]
}> {
  vi.resetModules()
  const mod = await import('../../../../engine/extensions/sdk/ion-sdk/runtime-async')
  const calls: RpcCall[] = []
  mod.registerRpcBridge(async (method: string, params: unknown) => {
    calls.push({ method, params })
    return {}
  })
  return { mod, calls }
}

// Flip the runtime into the post-init (dynamic) state so register* calls route
// through the RPC bridge instead of the pending-init queue.
function markInitResolved(mod: { drainPendingInit: () => unknown }): void {
  mod.drainPendingInit()
}

const noopScheduleHandler = async () => {}
const noopWebhookHandler = async () => ({ status: 200, body: '' })

beforeEach(() => {
  vi.resetModules()
})

describe('schedule serialization (post-init RPC path)', () => {
  it('forwards concurrency="all" for daily/weekly/interval when requested (regression #226)', async () => {
    const cases: Array<{ kind: string; register: (mod: any) => Promise<unknown> }> = [
      {
        kind: 'daily',
        register: (mod) =>
          mod.scheduleApi.daily({ id: 'd1', time: '09:00', concurrency: 'all', handler: noopScheduleHandler }),
      },
      {
        kind: 'weekly',
        register: (mod) =>
          mod.scheduleApi.weekly({ id: 'w1', time: '09:00', dayOfWeek: 'monday', concurrency: 'all', handler: noopScheduleHandler }),
      },
      {
        kind: 'interval',
        register: (mod) =>
          mod.scheduleApi.interval({ id: 'i1', intervalMs: 60000, concurrency: 'all', handler: noopScheduleHandler }),
      },
    ]

    for (const c of cases) {
      const { mod, calls } = await freshRuntime()
      markInitResolved(mod)
      await c.register(mod)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('ext/register_schedule')
      expect(calls[0].params.kind).toBe(c.kind)
      expect(calls[0].params.concurrency).toBe('all')
    }
  })

  it('omits the concurrency key entirely when unset', async () => {
    const { mod, calls } = await freshRuntime()
    markInitResolved(mod)
    await mod.scheduleApi.daily({ id: 'd2', time: '10:30', handler: noopScheduleHandler })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('ext/register_schedule')
    expect('concurrency' in calls[0].params).toBe(false)
  })

  it('forwards concurrency="single" explicitly when requested', async () => {
    const { mod, calls } = await freshRuntime()
    markInitResolved(mod)
    await mod.scheduleApi.interval({ id: 'i2', intervalMs: 5000, concurrency: 'single', handler: noopScheduleHandler })
    expect(calls[0].params.concurrency).toBe('single')
  })
})

describe('schedule init-drain path (pre-init queue)', () => {
  it('drains weekly job with concurrency and every kind-specific field', async () => {
    const { mod } = await freshRuntime()
    await mod.scheduleApi.weekly({
      id: 'w-drain',
      time: '23:15',
      dayOfWeek: 'friday',
      tz: 'America/New_York',
      timeoutMs: 30000,
      concurrency: 'all',
      enabled: () => true,
      handler: noopScheduleHandler,
    })
    const drained = mod.drainPendingInit()
    expect(drained.schedules).toHaveLength(1)
    const job = drained.schedules[0] as any
    expect(job.id).toBe('w-drain')
    expect(job.kind).toBe('weekly')
    expect(job.time).toBe('23:15')
    expect(job.dayOfWeek).toBe('friday')
    expect(job.tz).toBe('America/New_York')
    expect(job.timeoutMs).toBe(30000)
    expect(job.concurrency).toBe('all')
    expect(job.enabledRefName).toBe('schedule:w-drain:enabled')
  })

  it('drains interval job carrying intervalMs and concurrency', async () => {
    const { mod } = await freshRuntime()
    await mod.scheduleApi.interval({ id: 'i-drain', intervalMs: 90000, concurrency: 'all', handler: noopScheduleHandler })
    const drained = mod.drainPendingInit()
    const job = drained.schedules[0] as any
    expect(job.intervalMs).toBe(90000)
    expect(job.concurrency).toBe('all')
  })

  it('omits concurrency in the drained job when unset, and leaves enabledRefName empty without a predicate', async () => {
    const { mod } = await freshRuntime()
    await mod.scheduleApi.daily({ id: 'd-drain', time: '06:00', handler: noopScheduleHandler })
    const drained = mod.drainPendingInit()
    const job = drained.schedules[0] as any
    expect('concurrency' in job).toBe(false)
    expect(job.enabledRefName).toBe('')
  })
})

describe('webhook serialization (post-init RPC path)', () => {
  it('forwards concurrency when set and omits it when unset (regression)', async () => {
    const withConcurrency = await freshRuntime()
    markInitResolved(withConcurrency.mod)
    await withConcurrency.mod.webhooksApi.register({
      path: '/hook-a',
      auth: { kind: 'none' },
      concurrency: 'all',
      handler: noopWebhookHandler,
    })
    expect(withConcurrency.calls[0].method).toBe('ext/register_webhook')
    expect(withConcurrency.calls[0].params.concurrency).toBe('all')

    const withoutConcurrency = await freshRuntime()
    markInitResolved(withoutConcurrency.mod)
    await withoutConcurrency.mod.webhooksApi.register({
      path: '/hook-b',
      auth: { kind: 'none' },
      handler: noopWebhookHandler,
    })
    expect('concurrency' in withoutConcurrency.calls[0].params).toBe(false)
  })

  it('preserves path/method/maxBodyBytes/interface on the wire', async () => {
    const { mod, calls } = await freshRuntime()
    markInitResolved(mod)
    await mod.webhooksApi.register({
      path: '/hook-c',
      method: 'GET',
      maxBodyBytes: 4096,
      interface: '0.0.0.0',
      auth: { kind: 'none' },
      handler: noopWebhookHandler,
    })
    const p = calls[0].params
    expect(p.path).toBe('/hook-c')
    expect(p.method).toBe('GET')
    expect(p.maxBodyBytes).toBe(4096)
    expect(p.interface).toBe('0.0.0.0')
  })

  it('strips the callable token and substitutes a tokenRefName (bearer)', async () => {
    const { mod, calls } = await freshRuntime()
    markInitResolved(mod)
    await mod.webhooksApi.register({
      path: '/hook-bearer',
      auth: { kind: 'bearer', token: () => 'secret-value' },
      handler: noopWebhookHandler,
    })
    const auth = calls[0].params.auth
    expect(auth.kind).toBe('bearer')
    expect(typeof auth.token).toBe('undefined')
    expect(auth.tokenRefName).toBe('webhook:/hook-bearer:token')
  })

  it('preserves headerName for shared-secret auth', async () => {
    const { mod, calls } = await freshRuntime()
    markInitResolved(mod)
    await mod.webhooksApi.register({
      path: '/hook-shared',
      auth: { kind: 'shared-secret', headerName: 'X-Secret', token: () => 'k' },
      handler: noopWebhookHandler,
    })
    const auth = calls[0].params.auth
    expect(auth.kind).toBe('shared-secret')
    expect(auth.headerName).toBe('X-Secret')
    expect(auth.tokenRefName).toBe('webhook:/hook-shared:token')
    expect(typeof auth.token).toBe('undefined')
  })

  it('preserves headerName and algorithm for hmac-signature auth', async () => {
    const { mod, calls } = await freshRuntime()
    markInitResolved(mod)
    await mod.webhooksApi.register({
      path: '/hook-hmac',
      auth: { kind: 'hmac-signature', headerName: 'X-Sig', algorithm: 'sha256', token: () => 'k' },
      handler: noopWebhookHandler,
    })
    const auth = calls[0].params.auth
    expect(auth.kind).toBe('hmac-signature')
    expect(auth.headerName).toBe('X-Sig')
    expect(auth.algorithm).toBe('sha256')
    expect(auth.tokenRefName).toBe('webhook:/hook-hmac:token')
  })

  it('emits kind="none" auth with no tokenRefName', async () => {
    const { mod, calls } = await freshRuntime()
    markInitResolved(mod)
    await mod.webhooksApi.register({ path: '/hook-none', auth: { kind: 'none' }, handler: noopWebhookHandler })
    const auth = calls[0].params.auth
    expect(auth.kind).toBe('none')
    expect(auth.tokenRefName).toBeUndefined()
  })
})

describe('webhook init-drain path (pre-init queue)', () => {
  it('drains route carrying concurrency and stripped auth', async () => {
    const { mod } = await freshRuntime()
    await mod.webhooksApi.register({
      path: '/drain-hook',
      method: 'POST',
      auth: { kind: 'bearer', token: () => 'tok' },
      concurrency: 'all',
      handler: noopWebhookHandler,
    })
    const drained = mod.drainPendingInit()
    expect(drained.webhooks).toHaveLength(1)
    const route = drained.webhooks[0] as any
    expect(route.path).toBe('/drain-hook')
    expect(route.concurrency).toBe('all')
    expect(route.auth.tokenRefName).toBe('webhook:/drain-hook:token')
    expect(typeof route.auth.token).toBe('undefined')
  })
})

describe('fire_async dispatch round-trips', () => {
  const buildContext = (raw: any) => ({ sessionKey: raw?.sessionKey ?? '' }) as any

  it('returns the handler response for a webhook fire', async () => {
    const { mod } = await freshRuntime()
    await mod.webhooksApi.register({
      path: '/fire-hook',
      auth: { kind: 'none' },
      handler: async () => ({ status: 201, body: 'created', headers: { 'X-A': '1' } }),
    })
    const out = (await mod.dispatchFireAsync(
      { kind: 'webhook', id: '/fire-hook', payload: { method: 'POST', body: '{}' } },
      buildContext,
    )) as any
    expect(out.status).toBe(201)
    expect(out.body).toBe('created')
    expect(out.headers).toEqual({ 'X-A': '1' })
  })

  it('returns {ok:true} for a schedule fire', async () => {
    const { mod } = await freshRuntime()
    let fired = false
    await mod.scheduleApi.daily({ id: 'fire-sched', time: '00:00', handler: async () => { fired = true } })
    const out = (await mod.dispatchFireAsync({ kind: 'schedule', id: 'fire-sched', payload: {} }, buildContext)) as any
    expect(out).toEqual({ ok: true })
    expect(fired).toBe(true)
  })

  it('throws on unknown kind and unknown id', async () => {
    const { mod } = await freshRuntime()
    await expect(mod.dispatchFireAsync({ kind: 'mystery', id: 'x', payload: {} }, buildContext)).rejects.toThrow()
    await expect(mod.dispatchFireAsync({ kind: 'schedule', id: 'missing', payload: {} }, buildContext)).rejects.toThrow()
  })
})

describe('resolve_token / resolve_predicate dispatch', () => {
  it('resolves a registered token and fails closed to empty when absent', async () => {
    const { mod } = await freshRuntime()
    await mod.webhooksApi.register({
      path: '/tok-hook',
      auth: { kind: 'bearer', token: () => 'resolved-secret' },
      handler: noopWebhookHandler,
    })
    const hit = (await mod.dispatchResolveToken({ name: 'webhook:/tok-hook:token' })) as any
    expect(hit.value).toBe('resolved-secret')
    const miss = (await mod.dispatchResolveToken({ name: 'webhook:/nope:token' })) as any
    expect(miss.value).toBe('')
  })

  it('resolves a registered predicate and fails OPEN to enabled when absent', async () => {
    const { mod } = await freshRuntime()
    await mod.scheduleApi.daily({ id: 'pred-sched', time: '00:00', enabled: () => false, handler: noopScheduleHandler })
    const hit = (await mod.dispatchResolvePredicate({ name: 'schedule:pred-sched:enabled' })) as any
    expect(hit.enabled).toBe(false)
    const miss = (await mod.dispatchResolvePredicate({ name: 'schedule:absent:enabled' })) as any
    expect(miss.enabled).toBe(true)
  })
})

describe('unregister', () => {
  it('post-init webhook unregister issues ext/deregister_webhook and stops dispatch', async () => {
    const { mod, calls } = await freshRuntime()
    markInitResolved(mod)
    const handle = await mod.webhooksApi.register({ path: '/u-hook', auth: { kind: 'none' }, handler: noopWebhookHandler })
    await handle.unregister()
    const deregister = calls.find((c) => c.method === 'ext/deregister_webhook')
    expect(deregister?.params).toEqual({ path: '/u-hook' })
    await expect(
      mod.dispatchFireAsync({ kind: 'webhook', id: '/u-hook', payload: {} }, (raw: any) => raw),
    ).rejects.toThrow()
  })

  it('post-init schedule unregister issues ext/deregister_schedule', async () => {
    const { mod, calls } = await freshRuntime()
    markInitResolved(mod)
    const handle = await mod.scheduleApi.daily({ id: 'u-sched', time: '00:00', handler: noopScheduleHandler })
    await handle.unregister()
    const deregister = calls.find((c) => c.method === 'ext/deregister_schedule')
    expect(deregister?.params).toEqual({ id: 'u-sched' })
  })

  it('pre-init unregister trims the pending queue without an RPC', async () => {
    const { mod, calls } = await freshRuntime()
    const handle = await mod.scheduleApi.daily({ id: 'pre-sched', time: '00:00', handler: noopScheduleHandler })
    await handle.unregister()
    expect(calls).toHaveLength(0)
    const drained = mod.drainPendingInit()
    expect(drained.schedules).toHaveLength(0)
  })
})

describe('validation guards', () => {
  it('rejects a webhook path that does not start with "/"', async () => {
    const { mod } = await freshRuntime()
    await expect(
      mod.webhooksApi.register({ path: 'no-slash', auth: { kind: 'none' }, handler: noopWebhookHandler }),
    ).rejects.toThrow()
  })

  it('rejects a webhook with a non-function handler', async () => {
    const { mod } = await freshRuntime()
    await expect(
      mod.webhooksApi.register({ path: '/bad', auth: { kind: 'none' }, handler: undefined as any }),
    ).rejects.toThrow()
  })

  it('rejects a schedule with an empty id', async () => {
    const { mod } = await freshRuntime()
    await expect(
      mod.scheduleApi.daily({ id: '', time: '00:00', handler: noopScheduleHandler }),
    ).rejects.toThrow()
  })
})
