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
}

/** The two verdicts a tool_gate_response may carry. */
export type ToolGateDecision = 'allow' | 'deny'

/** The two gate request kinds: a policy question or a client-tool call. */
export type ToolGateKind = 'policy' | 'tool'
