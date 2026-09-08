/**
 * Tool-gate responder — the desktop's half of the engine's client tool gate.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 * The engine's workspace containment retains the generic git-worktree safety
 * rules (base-repo / sibling-worktree isolation, branch-identity protection,
 * detached-HEAD reporting). The BENCH rules — Ion's own integration-workspace
 * product — live here, in the client that owns the bench lifecycle, and reach
 * the agent through the engine's opt-in tool gate:
 *
 *   1. The desktop declares `toolGate` on EngineConfig at start_session
 *      (see toolGateSessionConfig): policy gating for the write/exec tools,
 *      plus the three bench client tools (WorkspaceAttribution,
 *      BenchMemberFile, BenchResolutionHistory).
 *   2. The engine emits `engine_tool_gate_request` before each gated call and
 *      blocks it; this module answers with `tool_gate_response`.
 *   3. gateKind 'policy' → evaluateToolGate (bench-tool-policy.ts) decides
 *      allow/deny. gateKind 'tool' → the matching BENCH_CLIENT_TOOLS handler
 *      executes and returns the result.
 *
 * ── Why the answer must be fast ─────────────────────────────────────────────
 * The gate wait sits on the engine's tool-loop hot path with a declared
 * bound (TOOL_GATE_TIMEOUT_MS). Policy evaluation is a record read plus a few
 * local git queries; measured well under the bound. The timeout fallback is
 * 'allow' — matching the workspace-guard philosophy that a false refusal
 * where the operator is working is worse than a briefly missing guard when
 * the desktop is mid-restart.
 *
 * ── Why this is not a permission queue ──────────────────────────────────────
 * engine_tool_gate_request is machine-answered and deliberately separate from
 * engine_permission_request. Nothing here renders UI or touches the
 * permission slices; a bench refusal reaches the operator only as the
 * model-visible tool error, exactly as the engine-side refusal did.
 */
import type { EngineEvent } from '../shared/types'
import type { ToolGateConfig } from '../shared/types-tool-gate'
import { evaluateToolGate } from './integration/bench-tool-policy'
import { BENCH_CLIENT_TOOLS } from './integration/bench-agent-tools'
import { ASK_USER_QUESTIONS_TOOL } from './questions/questions-tool-decl'
import { STUDIO_PLAYWRIGHT_TOOLS } from './studio-playwright/tools'
import { STUDIO_GRAPH_TOOLS } from './studio-graph/tools'
import { RENDER_CHART_TOOL, RENDER_CHART_TOOL_NAME, executeRenderChart } from './studio-chart-tool'
import { publishChartResource, type ChartPublishBridge } from './chart-resource-publish'
import {
  CONVERSATION_TELEMETRY_TOOL_NAME,
  conversationTelemetryTool,
  executeConversationTelemetry,
} from './telemetry/conversation-telemetry-tool'
import { log as _log, warn as _warn, error as _error } from './logger'
import { readSettings } from './settings-store'

const TAG = 'tool-gate'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }
function error(msg: string, fields?: Record<string, unknown>): void { _error(TAG, msg, fields) }

/**
 * Gate wait bound the desktop declares per session. Generous relative to the
 * measured policy cost (a stat + a few git subprocesses) so a cold page cache
 * or a slow disk does not convert a legitimate refusal into an allow-on-
 * timeout; still small enough that a hung desktop cannot stall a tool call
 * noticeably.
 */
export const TOOL_GATE_TIMEOUT_MS = 2000

/**
 * The write/exec tools the desktop gates. Narrow on purpose: ungated calls
 * (Read, Grep, Glob, …) pay zero round-trip. Bash is here because history
 * verbs arrive through it; the file-writers because a bench edit is destroyed
 * by the next assembly. ion_scaffold was gated by the old extension gate and
 * writes a directory tree, so it stays gated.
 */
export const GATED_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'ion_scaffold']

/**
 * Build the EngineConfig.toolGate declaration for a session.
 *
 * Declared on EVERY desktop session, not only bench-rooted ones: whether a
 * cwd is inside a bench can change mid-session (a bench is created while the
 * conversation runs), and the policy itself resolves the workspace fresh per
 * call. The engine's fast path keeps non-matching tools free, and the policy
 * returns allow immediately for a cwd with no bench involvement.
 *
 * Studio-only tools (the browser set, the graph set, and RenderChart) are
 * included only while the Studio presentation is active, because all three
 * produce output that only the Studio surface can host. Availability is
 * re-asserted on change through studio-client-tool-sync rather than
 * restarting sessions.
 *
 * `workingDirectory` selects the ConversationTelemetry variant. That tool is
 * declared with one name and no parameters in both cases; only its description
 * differs, because whether a session's work spans a worktree is a fact about
 * where it is running and not a choice the model should be making. Callers that
 * have no directory pass none and get the self-scoped wording, which is the
 * narrower of the two.
 */
export function toolGateSessionConfig(workingDirectory = ''): ToolGateConfig {
  const settings = readSettings()
  const studioActive = settings.activeUi === 'studio'
  const browserTools = studioActive && settings.studioPlaywrightEnabled !== false
    ? STUDIO_PLAYWRIGHT_TOOLS
    : []
  const chartTools = studioActive ? [RENDER_CHART_TOOL] : []
  // The Graph View is a Studio singleton surface, so the graph tools share
  // the chart tools' gate exactly: Studio active, nothing else.
  const graphTools = studioActive ? STUDIO_GRAPH_TOOLS : []
  return {
    enabled: true,
    tools: GATED_TOOLS,
    timeoutMs: TOOL_GATE_TIMEOUT_MS,
    timeoutDecision: 'allow',
    clientTools: [
      ...BENCH_CLIENT_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        planModeSafe: t.planModeSafe,
      })),
      ...browserTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        planModeSafe: t.planModeSafe,
      })),
      ...graphTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        planModeSafe: t.planModeSafe,
      })),
      ...chartTools,
      conversationTelemetryTool(workingDirectory),
      ASK_USER_QUESTIONS_TOOL,
    ],
    clientToolTimeoutMs: 30000,
  }
}

/**
 * Minimal bridge surface the responder needs (testability seam).
 *
 * `request` and `activeSessions` are here rather than imported from `./state`
 * so this module stays free of that module's construction side effects: the
 * control plane imports this file for `toolGateSessionConfig` alone, and must
 * not pull a live engine bridge into its import graph.
 */
export interface GateBridge extends ChartPublishBridge {
  on(event: 'event', listener: (key: string, event: EngineEvent) => void): unknown
  sendRaw(payload: Record<string, unknown>): void
  /** Session registry; a chart's owning conversation is read from here. */
  activeSessions: Map<string, { conversationId?: string }>
}

/**
 * Wire the responder onto a bridge. Called once at startup (state.ts).
 *
 * Every request is answered — allow, deny, tool result, or tool error — and
 * every answer is logged with its latency, so the gate's behavior is fully
 * reconstructable from desktop.jsonl. Handler failures fail OPEN for policy
 * (allow + error log) and CLOSED for tools (error result the model reads):
 * a policy crash must not block the operator's own work, while a tool crash
 * must surface as the tool's failure, never as a silent empty success.
 * (Human-wait tools never produce a gate request: the engine parks the run
 * instead — see ASK_USER_QUESTIONS_TOOL above.)
 */
export function wireToolGateResponder(bridge: GateBridge): void {
  bridge.on('event', (key: string, event: EngineEvent) => {
    if (event.type !== 'engine_tool_gate_request') return
    const started = Date.now()
    const req = event as Extract<EngineEvent, { type: 'engine_tool_gate_request' }>

    if (req.gateKind === 'tool') {
      void respondToolCall(bridge, key, req, started).catch((err: unknown) => {
        error('client tool responder failed after execution', {
          key,
          tool: req.gateToolName,
          error: String(err),
        })
      })
      return
    }
    respondPolicy(bridge, key, req, started)
  })
  log('tool-gate responder wired', {
    gated_tools: GATED_TOOLS,
    client_tools: [...BENCH_CLIENT_TOOLS, ...STUDIO_PLAYWRIGHT_TOOLS, ...STUDIO_GRAPH_TOOLS].map((t) => t.name)
      .concat(RENDER_CHART_TOOL_NAME, CONVERSATION_TELEMETRY_TOOL_NAME, ASK_USER_QUESTIONS_TOOL.name),
  })
}

function respondPolicy(
  bridge: GateBridge,
  key: string,
  req: Extract<EngineEvent, { type: 'engine_tool_gate_request' }>,
  started: number,
): void {
  let decision = 'allow'
  let reason = ''
  try {
    const denial = evaluateToolGate({
      toolName: req.gateToolName,
      input: (req.gateToolInput ?? {}) as Record<string, unknown>,
      cwd: req.gateCwd ?? '',
      siblingTools: req.gateSiblingTools,
    })
    if (denial) {
      decision = 'deny'
      reason = denial.reason
    }
  } catch (err) {
    // Fail OPEN: a policy crash must not block work in the operator's own
    // directory. The error is loud so the gap is queryable, not invisible.
    error('policy evaluation threw — failing open', {
      key, tool: req.gateToolName, error: String(err),
    })
  }
  bridge.sendRaw({
    cmd: 'tool_gate_response',
    key,
    gateRequestId: req.gateRequestId,
    gateDecision: decision,
    gateReason: reason,
  })
  const fields = {
    key, gate_request_id: req.gateRequestId, tool: req.gateToolName,
    decision, latency_ms: Date.now() - started,
  }
  if (decision === 'deny') {
    log('gate denied tool call', { ...fields, reason })
  } else {
    log('gate allowed tool call', fields)
  }
}

async function respondToolCall(
  bridge: GateBridge,
  key: string,
  req: Extract<EngineEvent, { type: 'engine_tool_gate_request' }>,
  started: number,
): Promise<void> {
  const settings = readSettings()
  const studioActive = settings.activeUi === 'studio'
  const browserTool = studioActive && settings.studioPlaywrightEnabled !== false
    ? STUDIO_PLAYWRIGHT_TOOLS.find((candidate) => candidate.name === req.gateToolName)
    : undefined
  const graphTool = studioActive
    ? STUDIO_GRAPH_TOOLS.find((candidate) => candidate.name === req.gateToolName)
    : undefined
  const benchTool = BENCH_CLIENT_TOOLS.find((candidate) => candidate.name === req.gateToolName)
  const isChartTool = studioActive && req.gateToolName === RENDER_CHART_TOOL_NAME
  const isTelemetryTool = req.gateToolName === CONVERSATION_TELEMETRY_TOOL_NAME
  let content: string
  let isError: boolean
  let images: unknown[] | undefined
  if (!benchTool && !browserTool && !graphTool && !isChartTool && !isTelemetryTool) {
    content = `client tool ${req.gateToolName} is not provided by this desktop`
    isError = true
    warn('client tool request for unknown tool', { key, tool: req.gateToolName })
  } else {
    try {
      if (isTelemetryTool) {
        // Scope and ownership come from the request and the session registry,
        // never from the model's arguments: which directory the session is
        // working in decides what the call covers, and the conversation id is
        // what the self-scoped chain walks from.
        const conversationId = bridge.activeSessions.get(key)?.conversationId ?? ''
        const result = executeConversationTelemetry(req.gateCwd ?? '', conversationId)
        content = result.content
        isError = result.isError
      } else if (isChartTool) {
        // A chart belongs to a conversation, not to a tab: the durable
        // conversation id is what survives a tab close and a restart, so the
        // record is keyed on it. Ownership is read from the bridge's session
        // registry, never from the model's arguments.
        const conversationId = bridge.activeSessions.get(key)?.conversationId ?? ''
        const result = executeRenderChart(
          (req.gateToolInput ?? {}) as Record<string, unknown>,
          { sessionKey: key, conversationId, toolCallId: req.gateRequestId },
        )
        content = result.content
        isError = result.isError
        // Publish only after the store committed to disk, so no subscriber is
        // told about a chart a restart could not restore.
        if (result.publish) {
          await publishChartResource(bridge, key, result.publish.op, result.publish.record)
        }
      } else {
        // The remaining families take different execution inputs and that
        // difference is meaningful: a bench tool needs only the cwd, while a
        // browser or graph tool must be told WHICH conversation is calling and
        // whether the caller is the model or trusted extension code. Ownership
        // and origin are supplied here, never accepted from the model's
        // arguments.
        const result = benchTool
          ? await benchTool.execute((req.gateToolInput ?? {}) as Record<string, unknown>, req.gateCwd ?? '')
          : await (browserTool ?? graphTool)!.execute((req.gateToolInput ?? {}) as Record<string, unknown>, {
            sessionKey: key,
            cwd: req.gateCwd ?? '',
            origin: req.gateOrigin === 'extension' ? 'extension' : 'model',
          })
        content = result.content
        isError = result.isError
        images = 'images' in result && Array.isArray(result.images) ? result.images : undefined
      }
    } catch (err) {
      // Fail CLOSED for tools: the model must read the failure, not a
      // fabricated empty success.
      content = `client tool ${req.gateToolName} failed: ${String(err)}`
      isError = true
      error('client tool execution threw', { key, tool: req.gateToolName, error: String(err) })
    }
  }
  bridge.sendRaw({
    cmd: 'tool_gate_response',
    key,
    gateRequestId: req.gateRequestId,
    gateContent: content,
    gateIsError: isError,
    ...(images?.length ? { gateImages: images } : {}),
  })
  log('client tool fulfilled', {
    key, gate_request_id: req.gateRequestId, tool: req.gateToolName,
    is_error: isError, content_len: content.length, latency_ms: Date.now() - started,
  })
}
