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

import { createIon, log } from '../sdk/ion-sdk'

const ion = createIon()

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
