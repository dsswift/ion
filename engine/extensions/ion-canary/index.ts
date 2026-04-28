// ion-canary -- end-to-end exerciser for SDK surfaces.
//
// Tools (exposed for an integration test to invoke through the host):
//   canary_classify_tier   -> returns last-observed permission_classify return + last permission_request payload
//   canary_promote         -> registers an agent spec named in params.spec.name
//   canary_elicit          -> calls ctx.elicit(...) and returns the response
//   canary_sandbox         -> calls ctx.sandboxWrap(...) and returns the wrapped command
//   canary_typed_check     -> references typed payload fields; if this compiles cleanly the type story works
//
// Hooks:
//   permission_classify    -> always returns "CRITICAL" (lets tests verify tier flows through)
//   permission_request     -> stores last payload (lets tests verify tier appears on payload)
//   capability_match       -> when input matches a name we have queued via canary_promote, register the spec

import {
  createIon,
  log,
  type CompactionInfo,
  type ToolCallInfo,
  type ErrorInfo,
  type AgentSpec,
  type PermissionRequestInfo,
} from '../sdk/ion-sdk'

const ion = createIon()

let lastClassifyTier = ''
let lastPermissionRequest: PermissionRequestInfo | null = null
const queuedSpecs: Record<string, AgentSpec> = {}

ion.on('permission_classify', (_ctx, payload) => {
  // Tier label flows through to permission_request payload.
  lastClassifyTier = 'CRITICAL'
  if (payload.tool_name === '__skip_classify__') return ''
  return lastClassifyTier
})

ion.on('permission_request', (_ctx, payload) => {
  lastPermissionRequest = payload
})

ion.on('capability_match', (ctx, payload) => {
  const spec = queuedSpecs[payload.input]
  if (spec && ctx.registerAgentSpec) {
    // Register through the runtime callback exposed via ext/register_agent_spec.
    void ctx.registerAgentSpec(spec)
  }
  return undefined
})

// --- Typed-payload compile check ---
// If any of these references stop compiling, our type story is broken.
// Exported so esbuild does not strip the symbol; presence in the bundle
// is the proof.
export const _typedPayloadSmokeTest = (): void => {
  const _t: ToolCallInfo = { toolName: 'x', toolId: 'y', input: {} }
  const _c: CompactionInfo = { strategy: 'auto', messagesBefore: 1, messagesAfter: 1 }
  const _e: ErrorInfo = { message: 'x' }
  void _t
  void _c
  void _e
}

ion.registerTool({
  name: 'canary_classify_tier',
  description: 'Return the last permission_classify return value and the last permission_request payload',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({
    content: JSON.stringify({
      lastClassifyTier,
      lastPermissionRequest,
    }),
  }),
})

ion.registerTool({
  name: 'canary_promote',
  description: 'Queue a spec so the next capability_match for spec.name promotes it',
  parameters: {
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        description: 'AgentSpec to register on capability_match',
      },
    },
    required: ['spec'],
  },
  execute: async (params) => {
    const spec = params.spec as AgentSpec
    if (!spec?.name) {
      return { content: 'spec.name required', isError: true }
    }
    queuedSpecs[spec.name] = spec
    return { content: `queued ${spec.name}` }
  },
})

ion.registerTool({
  name: 'canary_elicit',
  description: 'Call ctx.elicit and return the response (or cancelled flag)',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string' },
      schema: { type: 'object' },
    },
  },
  execute: async (params, ctx) => {
    const result = await ctx.elicit({
      mode: params.mode || 'approval',
      schema: params.schema,
    })
    return { content: JSON.stringify(result) }
  },
})

ion.registerTool({
  name: 'canary_sandbox',
  description: 'Call ctx.sandboxWrap and return the wrapped command',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
    },
    required: ['command'],
  },
  execute: async (params, ctx) => {
    const result = await ctx.sandboxWrap(params.command, {
      fsAllowWrite: ['/tmp/ion-canary-allow'],
      netAllowedDomains: ['example.com'],
    })
    return { content: JSON.stringify(result) }
  },
})

ion.registerTool({
  name: 'canary_typed_check',
  description: 'No-op tool whose existence proves typed payloads compiled',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ content: 'typed_payloads_compile_ok' }),
})

ion.on('session_start', () => {
  log.info('ion-canary loaded')
})
