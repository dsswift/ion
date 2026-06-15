// ion-meta -- extension authoring harness.
//
// This is the orchestrator extension for building Ion Engine extensions,
// agents, skills, and hooks. It registers twelve tools (catalog/hook/SDK
// introspection, scaffolding, validation, inspection, typechecking,
// conversation/log introspection),
// exposes seven specialist sub-agents (orchestrator + six specialists),
// and ships a system-prompt persona generated from the live SDK source.
//
// Architecture sketch:
//   index.ts        -- this file. Hook wiring + tool registration only.
//   catalog.ts      -- introspect SDK types.ts for HookPayloadMap + IonContext.
//   persona.ts      -- compose the system-prompt addition for before_prompt.
//   agent-state.ts  -- emit engine_agent_state snapshots (complete-snapshot contract).
//   tools/*.ts      -- one file per registered tool.
//   agents/*.md     -- specialist sub-agent definitions discovered by engine.
//   docs/canonical/ -- Ion docs bundled at install time (ion_read_doc serves).
//
// The orchestrator spine wires:
//   session_start    -> log + emit initial agent panel snapshot
//   before_prompt    -> inject the persona as systemPrompt
//   agent_start/end  -> update active-specialist tracker, re-emit panel
//   capability_*     -> advertise extension-authoring capabilities
//   on_error         -> surface caught errors via engine_notify
//   session_end      -> wipe the panel (agents: [])

import { createIon, log } from '../sdk/ion-sdk'
import { loadPersona } from './persona'
import {
  emitInitialSnapshot,
  emitAgentRunning,
  emitAgentDone,
  emitTerminalSnapshot,
  SPECIALISTS,
} from './agent-state'
import { isFreshConversation } from './fresh-session'
import { WELCOME_MARKDOWN } from './greeting'
import { gateWriteToolCall } from './git-gate'
import {
  scaffoldTool,
  validateAgentTool,
  listHooksTool,
  listExtensionsTool,
  inspectExtensionTool,
  listSDKMethodsTool,
  readDocTool,
  validateManifestTool,
  typecheckExtensionTool,
  readConversationTool,
  listConversationsTool,
  searchLogsTool,
} from './tools'

const ion = createIon()

// Register a dispatch tool per specialist agent. Each tool hardcodes the
// agent name so the LLM can't forget to pass it. The generic Agent tool
// is suppressed in session_start below to eliminate ambiguity.
ion.registerAgentTools()

// ─── Hook wiring ──────────────────────────────────────────────────────────

ion.on('session_start', (ctx) => {
  log.info('ion-meta extension active', { sessionKey: ctx.sessionKey })
  // Suppress the generic Agent tool so the LLM can only use the
  // per-specialist dispatch tools registered by registerAgentTools().
  // This eliminates the ambiguity where the LLM might call Agent()
  // without a name parameter.
  try {
    ctx.suppressTool('Agent')
  } catch (err) {
    log.error('ion-meta: failed to suppress Agent tool', { err: (err as Error).message })
  }
  // Emit an initial agent-state snapshot so the desktop's Agents panel
  // reflects ion-meta the moment the session begins. Complete-snapshot
  // contract: this snapshot lists every specialist ion-meta exposes,
  // each marked idle except the orchestrator (running).
  try {
    emitInitialSnapshot(ctx)
  } catch (err) {
    log.error('ion-meta: initial agent snapshot failed', { err: (err as Error).message })
  }
  // First-touch greeting. Emit the canonical welcome markdown as an
  // engine_harness_message exactly once per logically-new conversation.
  // Freshness is detected by the absence of any on-disk conversation
  // file under ~/.ion/conversations/<sessionKey>.* — see
  // fresh-session.ts for the rationale (sessionKey is client-supplied
  // and not reliable on its own). Ordering: snapshot first so the
  // Agents panel populates before the welcome message renders.
  try {
    const fresh = isFreshConversation(ctx.sessionKey)
    if (fresh) {
      log.info('ion-meta: emitting first-session welcome', {
        sessionKey: ctx.sessionKey,
        messageLength: WELCOME_MARKDOWN.length,
      })
      ctx.emit({
        type: 'engine_harness_message',
        message: WELCOME_MARKDOWN,
        source: 'ion-meta',
        // Renderer-honored dedup hint. The desktop suppresses repeated
        // harness messages carrying the same `metadata.dedupKey` within
        // a single engine-instance scrollback, so the welcome is shown
        // at most once per tab even if `session_start` fires several
        // times before any user turn (e.g. app restart with no message
        // typed). The filesystem-based isFreshConversation check above
        // is the pre-emit optimization; this metadata is the safety
        // net. Namespace convention: `<extensionName>:<messageKey>`.
        // See engine-event-slice.ts (desktop) for the consumer side and
        // docs/protocol/server-events.md for the well-known-keys table.
        metadata: { dedupKey: 'ion-meta:welcome' },
      })
      log.info('ion-meta: welcome emit returned', { sessionKey: ctx.sessionKey })
    } else {
      log.info('ion-meta: continued conversation, suppressing welcome', {
        sessionKey: ctx.sessionKey,
      })
    }
  } catch (err) {
    log.error('ion-meta: welcome emission failed', {
      sessionKey: ctx.sessionKey,
      err: (err as Error).message,
      stack: (err as Error).stack,
    })
  }
})

ion.on('before_prompt', (ctx, _prompt) => {
  // Inject the persona on every prompt. The persona is cached per
  // extensionDir so this is cheap after the first call.
  return { systemPrompt: loadPersona(ctx.config.extensionDir) }
})

// Belt-and-suspenders: if the generic Agent tool is somehow called without
// a name (e.g. suppressTool failed, or another extension re-enabled it),
// try to resolve the specialist from the task text. The engine fires
// before_agent_start in the spawner when requestedName is empty; returning
// agentName here supplies the name for spec resolution.
ion.on('before_agent_start', (_ctx, info) => {
  if (info?.name) return undefined // already named — nothing to do
  const task = (info?.task ?? '').toLowerCase()
  if (!task) return undefined
  const match = classifyAgentFromTask(task)
  if (match) {
    log.info('ion-meta: before_agent_start resolved agent from task', { agent: match, taskLen: task.length })
    return { agentName: match }
  }
  return undefined
})

ion.on('agent_start', (ctx, info) => {
  // info.name is the agent name being dispatched (see AgentInfo in
  // types.ts). We re-emit the panel snapshot with this specialist
  // flipped to running. Unknown agent names (e.g. plain Agent-tool
  // dispatches outside our roster) are silently ignored inside
  // emitAgentRunning.
  try {
    const name = info?.name ?? ''
    const task = info?.task
    emitAgentRunning(ctx, name, task)
    if (name) {
      ctx.emit({ type: 'engine_working_message', message: `→ ${name}` })
    }
  } catch (err) {
    log.error('ion-meta: agent_start snapshot failed', { err: (err as Error).message })
  }
})

ion.on('agent_end', (ctx, info) => {
  try {
    // AgentInfo carries `name` and optional `task`; there is no result
    // field. We preserve the most recent task as the panel's lastWork.
    emitAgentDone(ctx, info?.name ?? '', info?.task)
  } catch (err) {
    log.error('ion-meta: agent_end snapshot failed', { err: (err as Error).message })
  }
})

// capability_discover and capability_match are observation-only from a TS
// extension: the engine's TS hook forwarders treat both hooks as
// string-returning, but the Go-side dispatcher expects [Capability] /
// CapabilityMatchResult structured returns. A TS string return is
// effectively dropped. We still wire the hooks so the panel and logs
// reflect that ion-meta participated in the discovery turn, and we use
// `capability_match` to surface a routing telemetry event for the
// desktop. Real runtime capability registration belongs in a Go
// extension or in `registerAgentSpec` side effects.

ion.on('capability_discover', (ctx) => {
  // Fire-and-forget telemetry: announce that ion-meta is present and
  // would advertise these capabilities if the TS surface supported
  // structured returns. The string-forwarder discards the return below.
  ctx.emit({
    type: 'ion_meta_capability_advertise',
    capabilities: [
      'extension.scaffold', 'extension.inspect', 'extension.test',
      'extension.validate', 'hook.explain', 'agent.author',
      'skill.author', 'orchestration.design',
    ],
  })
})

ion.on('capability_match', (ctx, payload) => {
  // payload.input is the user's raw input; payload.capabilities is the
  // engine's currently-registered capability id list. We perform a
  // coarse keyword classification and emit a custom event so the
  // desktop / log can show what ion-meta would route to. Returning
  // structured data is not useful from TS (see comment block above).
  const text = (payload?.input ?? '').toLowerCase()
  if (!text) return undefined

  const route = classifyIntent(text)
  if (route) {
    ctx.emit({
      type: 'ion_meta_intent_routed',
      input: payload.input,
      capability: route,
    })
  }
  return undefined
})

ion.on('on_error', (ctx, info) => {
  // Surface caught errors via engine_notify so the desktop user sees
  // them rather than having to tail engine.log. Severity defaults to
  // warn; the engine reserves error level for actionable engine
  // failures.
  const summary = info?.message ?? 'unknown error'
  const category = info?.category ?? 'unknown'
  ctx.emit({
    type: 'engine_notify',
    level: 'warn',
    message: `ion-meta caught ${category}: ${summary}`,
  })
  log.warn('ion-meta: on_error observed', {
    message: summary,
    category,
    retryable: info?.retryable,
  })
})

// ─── Deterministic write-gate ─────────────────────────────────────────────
//
// Refuse write-class tool calls (Write / Edit / Bash / ion_scaffold) when
// the target isn't inside a git working tree. Engine-level enforcement;
// the LLM cannot override. See git-gate.ts for the design rationale and
// docs/architecture/adr/006-deterministic-seams-and-probabilistic-judgment.md
// for the framing.
//
// Returning `{ block: true, reason }` blocks the tool call; the engine
// surfaces the reason back to the LLM as the tool result. Returning
// `undefined` allows the call. Per the logging policy every decision
// (block AND pass) is observable through logs alone — this hook is on
// the critical path of every write-class operation, so we log both
// branches.
ion.on('tool_call', (ctx, info) => {
  try {
    const decision = gateWriteToolCall(
      { toolName: info?.toolName ?? '', toolId: info?.toolId ?? '', input: info?.input ?? {} },
      ctx.cwd,
    )
    if (decision.block) {
      log.info('ion-meta: git-gate blocked write-class tool', {
        tool: info?.toolName,
        toolId: info?.toolId,
        path: decision.path,
        sessionKey: ctx.sessionKey,
        reason: decision.reason,
      })
      return { block: true, reason: decision.reason ?? 'blocked by ion-meta git-gate' }
    }
    // Pass-case log at debug level: every tool call goes through this
    // hook, so logging every pass at info would be noisy. The block
    // case is the load-bearing audit signal.
    log.debug('ion-meta: git-gate passed tool call', {
      tool: info?.toolName,
      toolId: info?.toolId,
      sessionKey: ctx.sessionKey,
    })
    return undefined
  } catch (err) {
    // The gate is best-effort; if it crashes (e.g. permission error on
    // a stat call) we fail OPEN — the engine continues with the tool
    // call. Failing closed would make a buggy gate take the whole
    // harness down, which is worse than allowing a write through.
    log.error('ion-meta: git-gate threw, failing open', {
      tool: info?.toolName,
      err: (err as Error).message,
    })
    return undefined
  }
})

ion.on('session_end', (ctx) => {
  // Wipe the panel. The engine_agent_state contract requires us to emit
  // `agents: []` (or transition every agent to a terminal status); the
  // empty form is the canonical "session reset" signal per
  // docs/architecture/agent-state.md.
  try {
    emitTerminalSnapshot(ctx)
  } catch (err) {
    log.error('ion-meta: terminal snapshot failed', { err: (err as Error).message })
  }
  log.info('ion-meta extension inactive', { sessionKey: ctx.sessionKey })
})

// ─── Tool registration ────────────────────────────────────────────────────

ion.registerTool(scaffoldTool)
ion.registerTool(validateAgentTool)
ion.registerTool(listHooksTool)
ion.registerTool(listExtensionsTool)
ion.registerTool(inspectExtensionTool)
ion.registerTool(listSDKMethodsTool)
ion.registerTool(readDocTool)
ion.registerTool(validateManifestTool)
ion.registerTool(typecheckExtensionTool)
ion.registerTool(readConversationTool)
ion.registerTool(listConversationsTool)
ion.registerTool(searchLogsTool)

// ─── Helpers ──────────────────────────────────────────────────────────────

function classifyIntent(text: string): string | undefined {
  const match = (...keywords: string[]) => keywords.some(k => text.includes(k))
  if (match('scaffold', 'create extension', 'new extension', 'bootstrap extension')) {
    return 'extension.scaffold'
  }
  if (match('inspect extension', 'what hooks does', 'list tools in', 'parse extension')) {
    return 'extension.inspect'
  }
  if (match('typecheck', 'esbuild', 'compile extension')) {
    return 'extension.test'
  }
  if (match('validate manifest', 'extension.json', 'validate agent')) {
    return 'extension.validate'
  }
  if (match('hook', 'payload', 'fires when', 'before_prompt', 'session_start')) {
    return 'hook.explain'
  }
  if (match('agent file', 'agent markdown', '.md file', 'agent hierarchy', 'parent agent')) {
    return 'agent.author'
  }
  if (match('skill ', 'skill file', 'skill prompt')) {
    return 'skill.author'
  }
  if (match('dispatch', 'engine_agent_state', 'agent panel', 'capability_match', 'multi-agent')) {
    return 'orchestration.design'
  }
  return undefined
}

/** Map task text to a specialist name for the before_agent_start fallback.
 *  Uses the same keyword-classification pattern as classifyIntent but maps
 *  to specialist names instead of capability ids. */
function classifyAgentFromTask(text: string): string | undefined {
  const m = (...kw: string[]) => kw.some(k => text.includes(k))
  if (m('agent file', 'agent markdown', 'agent hierarchy', 'agent design', 'parent agent', 'child agent')) return 'agent-designer'
  if (m('scaffold', 'create extension', 'new extension', 'bootstrap', 'build me', 'build a')) return 'extension-builder'
  if (m('audit', 'review', 'improve', 'refactor extension')) return 'extension-improver'
  if (m('extension structure', 'entry point', 'json-rpc', 'manifest', 'extension.json')) return 'extension-architect'
  if (m('hook', 'payload', 'before_prompt', 'session_start', 'turn_end', 'on_error')) return 'hook-specialist'
  if (m('skill file', 'skill prompt', 'write a skill')) return 'skill-author'
  if (m('test', 'mockprovider', 'integration test')) return 'testing-guide'
  if (m('dispatch', 'orchestrat', 'multi-agent', 'agent panel', 'capability')) return 'orchestration-designer'
  // Broad teaching intent — default to tutor
  if (m('how does', 'explain', 'what is', 'show me', 'example of', 'difference between')) return 'ion-tutor'
  return undefined
}
