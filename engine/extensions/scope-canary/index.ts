// Scope canary: a `scope: both` extension that branches its registrations on
// `ion.scope` before the init handshake, the way a real engine-scoped
// extension does. The engine host half declares the schedule; the session
// half declares the tool. The integration test (tests/integration/
// engine_host_test.go) loads both halves through the session manager and
// checks each one landed where the manifest scope says it must.
import { createIon, log } from '../sdk/ion-sdk'

const ion = createIon()

if (ion.isEngineScope()) {
  ion.schedule.interval({
    id: 'scope-canary-tick',
    intervalMs: 3600000,
    handler: async (ctx) => {
      // The fire runs in the headless session the engine minted; its key is
      // what proves the session was not borrowed from a conversation.
      log.info('scope canary fired', { sessionKey: ctx.sessionKey, scope: ion.scope })
    },
  })
} else {
  ion.registerTool({
    name: 'scope_canary_scope',
    description: 'Report the scope this process runs as',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: `scope:${ion.scope}` }),
  })
}

log.info('scope canary started', { scope: ion.scope })
