// Async-trigger test fixture extension. Registers a webhook route
// and an interval schedule at module scope so the integration tests
// can verify init-time declarations flow through the engine all the
// way into the host's asyncreg registry.
//
// Tools exposed for the test harness:
//   async_canary_register_dynamic_webhook -> dynamically registers
//     a second route from inside a tool call, exercising the
//     post-init RPC path.
//   async_canary_register_dynamic_schedule -> dynamically registers
//     a second interval job.
//   async_canary_arm_slow_handler -> configures the slow-handler
//     schedule for the schedule-fire-timeout integration test.

import { createIon, log } from '../sdk/ion-sdk'

const ion = createIon()

// ── Slow-handler probe: schedule-fire-timeout test fixture ────────────────────
//
// This schedule never auto-fires (intervalMs is enormous). The integration
// test fires it manually via host.FireAsync with a short timeout. The handler
// deliberately waits `slowHandlerDelayMs` milliseconds before making a
// ctx.dispatchAgent() call, so the Go-side timeout fires BEFORE the handler
// completes. After the timeout, the handler observes -32000 "dispatch not
// available" because ctxStack.Current() is nil (the deferred Pop in FireAsync
// already ran). The handler then emits a "sched_timeout_probe_result" event
// whose EventMessage carries the error text and whose metadata carries
// additional shape information about what the TS runtime actually exposed.
//
// Configuration is via module-level variables set by the
// async_canary_arm_slow_handler tool, called once before each FireAsync.
// This avoids any need to parse custom fields out of the fire payload.
let slowHandlerDelayMs = 0
let slowHandlerArmed = false

ion.schedule.interval({
  id: 'async-canary-slow-handler',
  // intervalMs is a required field for interval schedules. Use a very large
  // value so the scheduler never auto-fires this job during test runs.
  intervalMs: 86400000, // 24 hours — never auto-fires in test windows
  handler: async (ctx) => {
    if (!slowHandlerArmed) {
      // Not armed: skip silently. Should not happen in practice because the
      // test arms the handler before every FireAsync, but guard defensively.
      return
    }

    // Reset so a second unintended fire is a no-op.
    slowHandlerArmed = false
    const delayMs = slowHandlerDelayMs

    // Deliberately pause so the Go-side timeout fires before we complete.
    // The Go test issues FireAsync with a timeout shorter than delayMs,
    // so by the time we wake up and call ctx.dispatchAgent, the deferred
    // Pop in FireAsync has already run and ctxStack.Current() is nil.
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs))

    // Now issue ctx.dispatchAgent. This sends ext/dispatch_agent to Go.
    // Go's handleExtRequest calls ctxStack.Current() → nil → -32000.
    // The TS runtime.ts:778 rejects the pending promise with:
    //   new Error(msg.error.message || 'RPC error')
    // so the code field (-32000) is dropped; only the message string survives.
    let errorMessage = ''
    let errorHasCodeProperty = false
    let errorName = ''
    let err: unknown
    try {
      await ctx.dispatchAgent({ name: 'test-agent-never-exists' })
      // If we reach here the ctx was NOT nil — the defect did not trigger.
      errorMessage = 'UNEXPECTED_SUCCESS'
    } catch (caught: any) {
      err = caught
      errorMessage = String(caught?.message ?? caught ?? 'unknown error')
      errorName = String(caught?.name ?? '')
      // Check whether the -32000 code survived into the thrown Error object.
      // runtime.ts:778 uses only msg.error.message, so code is lost.
      errorHasCodeProperty = 'code' in Object(caught)
    }

    // Emit the result via ctx.emit. Because the Go-side ctxStack is empty
    // at this point, the ext/emit notification is routed by Go's
    // handleExtNotification to the persistentEmit fallback rather than
    // the (absent) ctx.Emit. This means the Go integration test catches
    // it via host.SetPersistentEmit. The routing itself proves ctxStack
    // is empty — if a ctx were still on the stack, it would have been
    // used instead.
    ctx.emit({
      type: 'sched_timeout_probe_result',
      message: errorMessage,
      metadata: {
        errorName,
        errorHasCodeProperty,
        // If the error DID carry a code, record it.
        errorCode: errorHasCodeProperty ? String((err as any)?.code ?? '') : '',
      },
    } as any)
  },
})

// Tool to arm the slow-handler probe before a test fire. Call this once
// immediately before the Go test issues host.FireAsync so the module-level
// configuration is in place. The handler resets slowHandlerArmed to false
// on entry so subsequent unintended fires are no-ops.
ion.registerTool({
  name: 'async_canary_arm_slow_handler',
  description: 'Configure the slow-handler schedule for the fire-timeout integration test',
  parameters: {
    type: 'object',
    properties: {
      delayMs: { type: 'number', description: 'How long the handler pauses before issuing ctx.dispatchAgent' },
    },
    required: ['delayMs'],
  },
  execute: async (params: any) => {
    slowHandlerDelayMs = Number(params?.delayMs ?? 50)
    slowHandlerArmed = true
    return { content: 'armed' }
  },
})

// Static webhook registration. The handler simply echoes back the
// JSON body. Token is read from process.env so secrets never sit in
// extension source.
ion.webhooks.register({
  path: '/test/hello',
  method: 'POST',
  auth: { kind: 'bearer', token: () => process.env.ASYNC_CANARY_TOKEN ?? 'test-secret' },
  handler: async (_ctx, req) => {
    const parsed = req.json<{ name?: string }>()
    return {
      status: 200,
      body: JSON.stringify({ greeted: parsed.name ?? 'world', echo: req.body }),
      headers: { 'X-Async-Canary': 'ok' },
    }
  },
})

// Static interval schedule. Fires every 1 second; the handler
// increments a module-scope counter so a test can verify fires
// happen.
let scheduleFireCount = 0
ion.schedule.interval({
  id: 'async-canary-tick',
  intervalMs: 1000,
  handler: async (_ctx) => {
    scheduleFireCount++
    log.info('async-canary tick', { count: scheduleFireCount })
  },
})

// Lifecycle hook: log every webhook registration / deregistration
// so a test can prove the hooks fire on init.
ion.on('webhook_registered', (_ctx, info: any) => {
  log.info('webhook_registered observed', { id: info?.id, origin: info?.origin })
})
ion.on('schedule_registered', (_ctx, info: any) => {
  log.info('schedule_registered observed', { id: info?.id, origin: info?.origin })
})

// Dynamic registration tools for the integration test.
ion.registerTool({
  name: 'async_canary_register_dynamic_webhook',
  description: 'Register a second webhook from inside a tool call',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    await ion.webhooks.register({
      path: '/test/dynamic',
      method: 'POST',
      auth: { kind: 'none' },
      handler: async () => ({ status: 200, body: 'dynamic' }),
    })
    return { content: 'ok' }
  },
})

ion.registerTool({
  name: 'async_canary_register_dynamic_schedule',
  description: 'Register a second interval from inside a tool call',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    await ion.schedule.interval({
      id: 'async-canary-dynamic',
      intervalMs: 2000,
      handler: async () => {},
    })
    return { content: 'ok' }
  },
})

// Tool that vetoes a registration via the lifecycle hook to verify
// the veto pipeline closes.
ion.registerTool({
  name: 'async_canary_install_blocker',
  description: 'Install a webhook_registered hook that blocks any path containing "blocked"',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    ion.on('webhook_registered', (_ctx, info: any) => {
      const id = String(info?.id ?? '')
      if (id.includes('blocked')) {
        return { block: true, reason: 'policy: blocked by test' }
      }
    })
    return { content: 'ok' }
  },
})

// Tool that attempts a registration that should be blocked.
ion.registerTool({
  name: 'async_canary_attempt_blocked_register',
  description: 'Try to register /test/blocked-path; should fail',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    try {
      await ion.webhooks.register({
        path: '/test/blocked-path',
        method: 'POST',
        auth: { kind: 'none' },
        handler: async () => ({ status: 200 }),
      })
      return { content: 'unexpected-success', isError: true }
    } catch (err: any) {
      return { content: String(err?.message ?? err) }
    }
  },
})

// Register an HMAC-signature route. The secret comes from
// ASYNC_CANARY_HMAC_SECRET so the e2e test can sign requests with
// the same key.
ion.registerTool({
  name: 'async_canary_register_hmac_route',
  description: 'Register POST /test/hmac with HMAC-SHA256 auth',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    await ion.webhooks.register({
      path: '/test/hmac',
      method: 'POST',
      auth: {
        kind: 'hmac-signature',
        headerName: 'X-Signature',
        algorithm: 'sha256',
        token: () => process.env.ASYNC_CANARY_HMAC_SECRET ?? '',
      },
      handler: async () => ({ status: 200, body: 'hmac-ok' }),
    })
    return { content: 'ok' }
  },
})

// Register a shared-secret route.
ion.registerTool({
  name: 'async_canary_register_shared_secret_route',
  description: 'Register POST /test/shared with shared-secret auth',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    await ion.webhooks.register({
      path: '/test/shared',
      method: 'POST',
      auth: {
        kind: 'shared-secret',
        headerName: 'X-Token',
        token: () => process.env.ASYNC_CANARY_SHARED_SECRET ?? '',
      },
      handler: async () => ({ status: 200, body: 'shared-ok' }),
    })
    return { content: 'ok' }
  },
})

// Register an interval with concurrency='all' mode. Used by the
// scheduler e2e tests to verify both concurrency modes.
ion.registerTool({
  name: 'async_canary_register_all_mode_interval',
  description: 'Register a 1s interval with concurrency=all',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    await ion.schedule.interval({
      id: 'async-canary-all-mode',
      intervalMs: 1000,
      concurrency: 'all',
      handler: async () => {
        log.info('all-mode tick')
      },
    })
    return { content: 'ok' }
  },
})

// Register an interval whose enabled predicate is always false. Used
// by the scheduler e2e tests to verify engine_schedule_skipped fires
// with reason='disabled'.
ion.registerTool({
  name: 'async_canary_register_disabled_interval',
  description: 'Register a 1s interval whose enabled predicate returns false',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    await ion.schedule.interval({
      id: 'async-canary-disabled',
      intervalMs: 1000,
      enabled: () => false,
      handler: async () => {
        // never called.
      },
    })
    return { content: 'ok' }
  },
})

// Register an interval whose handler throws. Used by the scheduler
// e2e tests to verify engine_schedule_failed fires.
ion.registerTool({
  name: 'async_canary_register_failing_interval',
  description: 'Register a 1s interval whose handler throws',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    await ion.schedule.interval({
      id: 'async-canary-failing',
      intervalMs: 1000,
      handler: async () => {
        throw new Error('intentional canary failure')
      },
    })
    return { content: 'ok' }
  },
})

// Register a daily job at a far-future time so the test can confirm
// the scheduler picks it up without it actually firing during the
// test window. The bootstrap path runs once and writes nothing — used
// to exercise the persistence-directory wire-up.
ion.registerTool({
  name: 'async_canary_register_daily_job',
  description: 'Register a daily job at 03:00 (far future for a daytime test run)',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    await ion.schedule.daily({
      id: 'async-canary-daily',
      time: '03:00',
      tz: 'UTC',
      handler: async () => {
        // would fire daily at 03:00 UTC; never in a test window.
      },
    })
    return { content: 'ok' }
  },
})
