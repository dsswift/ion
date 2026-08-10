// parity-canary -- the TypeScript half of the dual-canary parity suite.
//
// This extension and engine/extensions/go-canary/main.go are written to be
// behaviourally identical: same name, same tools, same hooks, same webhook and
// schedule declarations, same emitted events. The parity suite
// (engine/tests/integration/parity_canary_test.go) runs each scenario against
// both and asserts the two produce the *same* observations, not merely that
// each passes on its own.
//
// That distinction is the point. Two independently-passing test suites can
// drift for a long time before anyone notices; a cross-assertion cannot.
//
// Any change here needs the same change in go-canary/main.go, or the cross
// subtest fails — which is the mechanism working.

import { createIon, log } from '../sdk/ion-sdk'

const ion = createIon()

// --- Tools -----------------------------------------------------------------

// Echoes its input back. Proves the tool round trip and the _ctx split: the
// session key comes from the envelope, the text from the arguments.
ion.registerTool({
  name: 'canary_echo',
  description: 'Echo the input text back',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  execute: async (params: any, ctx) => ({
    content: `echo:${params?.text ?? ''}:session:${ctx.sessionKey}`,
  }),
})

// Calls another tool through the engine while this one is still executing.
// Proves outbound-while-serving-inbound: a transport that blocked its read
// loop on its own pending call would hang here.
ion.registerTool({
  name: 'canary_call_tool',
  description: 'Call another tool from inside a tool',
  parameters: {
    type: 'object',
    properties: { target: { type: 'string' } },
    required: ['target'],
  },
  execute: async (params: any, ctx) => {
    const result = await ctx.callTool(params?.target ?? '', {})
    return { content: `nested:${result.content}` }
  },
})

// --- Commands --------------------------------------------------------------

ion.registerCommand('canary', {
  description: 'Canary command',
  execute: async (args, ctx) => {
    log.info('canary command invoked', { args, sessionKey: ctx.sessionKey })
  },
})

// --- Hooks -----------------------------------------------------------------

// Emits during a hook, so the response carries a batched events array rather
// than a standalone ext/emit notification.
ion.on('session_start', (ctx) => {
  ctx.emit({
    type: 'engine_harness_message',
    message: 'canary session start',
  })
})

// Rewrites the prompt. The payload arrives as a bare string, so this also
// exercises the _payload unwrap.
ion.on('before_prompt', (_ctx, prompt) => ({
  prompt: `${prompt} [canary]`,
}))

// Returns a typed veto result without blocking, exercising the block-shaped
// return path.
ion.on('tool_call', (_ctx, info) => {
  if (info.toolName === '__canary_blocked__') {
    return { block: true, reason: 'canary refuses this tool' }
  }
  return undefined
})

// --- Async triggers --------------------------------------------------------

// Declared at module scope, so both must ride the init handshake rather than
// going out as post-init RPCs.
ion.webhooks.register({
  path: '/canary/hello',
  method: 'POST',
  auth: { kind: 'none' },
  handler: async (_ctx, req) => {
    const parsed = req.json<{ name?: string }>()
    return {
      status: 200,
      body: JSON.stringify({ greeted: parsed.name ?? 'world' }),
    }
  },
})

ion.schedule.interval({
  id: 'canary-tick',
  intervalMs: 60000,
  handler: async () => {
    log.info('canary tick')
  },
})

// --- Resources -------------------------------------------------------------

const canaryResource = ion.resources.declare({ kind: 'canary_note' })
void canaryResource

ion.resources.onQuery('canary_note', () => [
  {
    id: 'note-1',
    kind: 'canary_note',
    title: 'Canary note',
    content: 'from the canary',
    createdAt: '2026-01-01T00:00:00Z',
  },
])

// Startup log. The parity suite reads it to confirm the log notification path
// works identically from both SDKs.
log.info('canary started', { language: 'typescript' })
