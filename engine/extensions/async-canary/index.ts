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
