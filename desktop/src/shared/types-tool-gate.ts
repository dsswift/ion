// Client tool-gate types (EngineConfig.toolGate). Mirrors the Go source of
// truth in engine/internal/types/tool_gate.go — the opt-in seam that lets a
// session's owning client answer engine_tool_gate_request events with
// tool_gate_response commands before gated tool calls execute.
//
// Split from types-engine.ts for the 600-line cap; re-exported through the
// types.ts barrel like every other domain module.

/** Client declaration for the engine's opt-in tool gate (EngineConfig.toolGate). */
export interface ToolGateConfig {
  enabled: boolean
  /** Narrow gating to these tool names. Empty/absent gates every tool call. */
  tools?: string[]
  /** Wait bound per gated call in ms. Absent resolves to the engine default (2000). */
  timeoutMs?: number
  /** Decision applied when no answer arrives in time: 'allow' (default) or 'deny'. */
  timeoutDecision?: 'allow' | 'deny'
  /**
   * Tools the CLIENT executes. Each joins the session's tool list like an
   * extension or MCP tool; a call arrives as engine_tool_gate_request with
   * gateKind 'tool' and is answered with gateContent/gateIsError. The third
   * tool provision path beside MCP servers and extensions.
   */
  clientTools?: ClientToolDef[]
  /** Fulfillment bound per client-tool call in ms. Absent resolves to the engine default (30000). */
  clientToolTimeoutMs?: number
}

/** One client-executed tool declaration (ToolGateConfig.clientTools). */
export interface ClientToolDef {
  name: string
  description?: string
  /** JSON-Schema object, same shape extension tools declare. */
  inputSchema?: Record<string, unknown>
  /** Marks the tool callable in plan mode (read-only tools). */
  planModeSafe?: boolean
  /**
   * Marks this tool as an intentional HUMAN wait: the model's call blocks on
   * a person, not on client software. The engine PARKS the run on invocation
   * — the request is retained as a PermissionDenial (re-published on every
   * idle status snapshot), the run terminates, and the session goes idle;
   * the user's answer arrives as the next prompt. False/absent keeps
   * machine-tool behavior (a blocking wire round-trip on a finite timeout).
   */
  humanWait?: boolean
}

/**
 * One pending client-tool call on the engine_client_tool_state snapshot.
 * Mirrors Go ClientToolCallState (engine/internal/types/tool_gate.go). The
 * snapshot is a complete replacement: consumers replace local state with the
 * payload, and an empty array is the authoritative clear signal.
 */
export interface ClientToolCallState {
  /** tool_gate_response correlator — answer this exact id. */
  requestId: string
  /** Owning run lifecycle; lets a client reject a stale persisted entry. */
  runId?: string
  toolName: string
  toolInput?: Record<string, unknown>
  cwd?: string
  /** Mirrors ClientToolDef.humanWait: render for a person vs answer programmatically. */
  humanWait?: boolean
  /** Unix-ms timestamp the engine registered the call. */
  startedAt?: number
}

/** The two verdicts a tool_gate_response may carry. */
export type ToolGateDecision = 'allow' | 'deny'

/** The two gate request kinds: a policy question or a client-tool call. */
export type ToolGateKind = 'policy' | 'tool'
