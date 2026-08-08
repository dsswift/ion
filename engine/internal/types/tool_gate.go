package types

// Tool gate — a client-owned, per-session tool-call policy seam.
//
// ── What this is ────────────────────────────────────────────────────────────
// A session's owning client may declare, at start_session, that it wants to be
// consulted before tool calls execute. When enabled, the engine emits an
// engine_tool_gate_request event for each matching tool call and briefly
// blocks that call's goroutine until the client answers with a
// tool_gate_response command (or the declared timeout elapses). The client's
// answer is a machine decision, not a human prompt: this is how a harness
// enforces policy the engine deliberately has no opinion about (a product's
// workspace rules, a fleet's compliance gates, a pipeline's dry-run mode).
//
// ── Why this is engine mechanism, not opinion ───────────────────────────────
// The engine owns the dirty work every consumer would otherwise reimplement:
// suspending a tool call inside the parallel tool loop, transporting the
// question, bounding the wait, and applying a declared fallback when no answer
// arrives. It ships no policy: gating is off unless the client opts in, the
// engine never decides allow/deny itself, and the timeout fallback is the
// client's own declaration. See the "Opinionless mechanics" section of the
// repo AGENTS.md.
//
// ── Relationship to existing decision surfaces ──────────────────────────────
//   - permissions.Engine: the engine's own rule evaluation (allow/deny/ask),
//     configured by policy files. The tool gate runs AFTER it — a call the
//     permission engine denies never reaches the gate.
//   - workspace containment (internal/workspaces): the engine's deterministic
//     worktree safety baseline. Also runs before the gate.
//   - tool_call extension hook: subprocess-extension policy. Runs after the
//     gate — the session owner's refusal preempts extension processing.
//   - engine_permission_request: a HUMAN ask. Clients surface it in approval
//     UI. The tool gate is a separate event precisely so a programmatic
//     policy question never lands in a human permission queue.
//
// ── Failure mode is declared, never guessed ─────────────────────────────────
// The gate fails toward TimeoutDecision when the client does not answer in
// time. The default is "allow": a gate exists to let a client refuse specific
// calls, and a briefly absent client must not paralyze the session. A client
// whose policy is safety-critical declares "deny" and accepts that its own
// unavailability stops tool execution.

// ToolGateConfig is a client's opt-in declaration, carried on EngineConfig at
// start_session. Nil (absent) means no gating: zero new behavior for every
// existing consumer.
type ToolGateConfig struct {
	// Enabled turns the gate on for this session.
	Enabled bool `json:"enabled"`
	// Tools optionally narrows gating to these tool names. Empty means every
	// tool call is gated. A narrow list is cheaper: ungated calls pay nothing.
	Tools []string `json:"tools,omitempty"`
	// TimeoutMs bounds how long one tool call waits for the client's answer.
	// Zero or negative resolves to the built-in default (2000ms). This wait
	// sits on the tool loop's hot path; clients should answer in single-digit
	// milliseconds and declare a bound that covers their worst case only.
	TimeoutMs int `json:"timeoutMs,omitempty"`
	// TimeoutDecision is applied when no answer arrives in time:
	// "allow" (default) or "deny". A "deny" timeout produces a tool error
	// naming the gate timeout so the model knows the call was never executed.
	TimeoutDecision string `json:"timeoutDecision,omitempty"`
	// ClientTools declares tools the CLIENT executes. Each is added to the
	// session's tool list like an extension or MCP tool; when the model calls
	// one, the engine emits engine_tool_gate_request with gateKind "tool" and
	// blocks until the client's tool_gate_response carries the result
	// (gateContent / gateIsError) or ClientToolTimeoutMs elapses. This is how
	// a wire consumer provides tools without writing an extension or an MCP
	// server — the third provision path beside those two.
	ClientTools []ClientToolDef `json:"clientTools,omitempty"`
	// ClientToolTimeoutMs bounds one client-tool execution. Zero or negative
	// resolves to the built-in default (30000ms) — generous relative to
	// TimeoutMs because fulfillment does real work (git queries, file reads),
	// not just a policy lookup.
	ClientToolTimeoutMs int `json:"clientToolTimeoutMs,omitempty"`
}

// ClientToolDef is one client-executed tool declaration.
type ClientToolDef struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// InputSchema is a JSON-Schema object, same shape extension tools declare.
	InputSchema map[string]any `json:"inputSchema,omitempty"`
	// PlanModeSafe marks the tool callable in plan mode (read-only tools).
	PlanModeSafe bool `json:"planModeSafe,omitempty"`
}

// ToolGateTimeoutMsDefault is the wait bound applied when a gating client
// declares no TimeoutMs. Generous relative to the early-stop wire timeout
// (100ms) because a gate decision may legitimately consult local state
// (a registry file, a git query); still bounded so an absent client cannot
// wedge a tool call indefinitely.
const ToolGateTimeoutMsDefault = 2000

// ClientToolTimeoutMsDefault is the fulfillment bound applied when a client
// declares tools but no ClientToolTimeoutMs.
const ClientToolTimeoutMsDefault = 30000

// GateKindPolicy / GateKindTool distinguish the two gate request kinds on the
// wire: a policy question (answer allow/deny) and a tool fulfillment (answer
// with a result).
const (
	GateKindPolicy = "policy"
	GateKindTool   = "tool"
)

// GateDecisionAllow / GateDecisionDeny are the two verdicts a
// tool_gate_response may carry, and the two values TimeoutDecision accepts.
const (
	GateDecisionAllow = "allow"
	GateDecisionDeny  = "deny"
)

// Applies reports whether the config gates the named tool. Nil-safe: a nil or
// disabled config gates nothing.
func (c *ToolGateConfig) Applies(toolName string) bool {
	if c == nil || !c.Enabled {
		return false
	}
	if len(c.Tools) == 0 {
		return true
	}
	for _, t := range c.Tools {
		if t == toolName {
			return true
		}
	}
	return false
}

// ResolveTimeoutMs returns the declared wait bound or the default.
func (c *ToolGateConfig) ResolveTimeoutMs() int {
	if c == nil || c.TimeoutMs <= 0 {
		return ToolGateTimeoutMsDefault
	}
	return c.TimeoutMs
}

// ResolveClientToolTimeoutMs returns the declared fulfillment bound or the
// default.
func (c *ToolGateConfig) ResolveClientToolTimeoutMs() int {
	if c == nil || c.ClientToolTimeoutMs <= 0 {
		return ClientToolTimeoutMsDefault
	}
	return c.ClientToolTimeoutMs
}

// ResolveTimeoutDecision returns the declared timeout fallback, defaulting to
// allow. Any value other than GateDecisionDeny resolves to allow — an
// unrecognized declaration must not invent a refusal.
func (c *ToolGateConfig) ResolveTimeoutDecision() string {
	if c != nil && c.TimeoutDecision == GateDecisionDeny {
		return GateDecisionDeny
	}
	return GateDecisionAllow
}
