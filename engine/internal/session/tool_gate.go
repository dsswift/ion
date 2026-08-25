package session

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Client tool gate — session-side bridge.
//
// The tool loop's RunHooks.OnToolGate callback (wired in prompt_runconfig.go
// only for sessions whose EngineConfig.ToolGate opted in) lands here: emit an
// engine_tool_gate_request event, block on the broker channel bounded by the
// client's declared timeout, and translate the outcome into the (decision,
// reason) pair the loop consumes. The failure mode is the client's own
// declaration (ToolGateConfig.TimeoutDecision), never a guess — see
// types/tool_gate.go for the full design framing.

// toolGateSeq disambiguates gate request IDs minted within the same
// nanosecond. Parallel tool calls in one turn all mint IDs at effectively the
// same instant, and a duplicate ID would cross-resolve two different calls.
var toolGateSeq atomic.Uint64

// HandleToolGateResponse resolves a pending tool-gate request. Called by the
// server when a `tool_gate_response` command arrives. Fire-and-forget: when no
// pending request matches (the tool loop's timeout already applied the
// declared fallback, or the response is stale), the response is dropped and
// the drop is logged — the loop has already moved on.
func (m *Manager) HandleToolGateResponse(key, gateRequestID, decision, reason, content string, isError bool) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "session.toolgate", "tool_gate_response for unknown session", map[string]any{"key": key, "gate_request_id": gateRequestID})
		return
	}
	reply := pending.ToolGateReply{Decision: decision, Reason: reason, Content: content, IsError: isError}
	if !s.pending.ResolveToolGate(gateRequestID, reply) {
		utils.LogWithFields(utils.LevelDebug, "session.toolgate", "no pending tool gate for session (likely timed out)", map[string]any{"key": key, "gate_request_id": gateRequestID})
	}
}

// requestToolGateDecision emits an engine_tool_gate_request event and blocks
// until the client answers or the declared timeout elapses. Returns the
// resolved (decision, reason). Every path logs: the request, the answer with
// its latency, and the timeout with the fallback applied.
func (m *Manager) requestToolGateDecision(
	key string,
	gateCfg *types.ToolGateConfig,
	toolName string,
	input map[string]interface{},
	cwd string,
	siblings []string,
) (string, string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		// The session is gone (stopped mid-run). Nothing to consult; allow —
		// the run itself is being torn down anyway.
		utils.LogWithFields(utils.LevelInfo, "session.toolgate", "gate skipped: session not found", map[string]any{"key": key, "tool": toolName})
		return types.GateDecisionAllow, ""
	}

	gateRequestID := fmt.Sprintf("tool-gate-%d-%d", time.Now().UnixNano(), toolGateSeq.Add(1))
	ch := s.pending.RegisterToolGate(gateRequestID)
	defer s.pending.UnregisterToolGate(gateRequestID)

	timeout := time.Duration(gateCfg.ResolveTimeoutMs()) * time.Millisecond
	start := time.Now()

	m.emit(key, types.EngineEvent{
		Type:             "engine_tool_gate_request",
		GateRequestID:    gateRequestID,
		GateKind:         types.GateKindPolicy,
		GateToolName:     toolName,
		GateToolInput:    input,
		GateCwd:          cwd,
		GateSiblingTools: siblings,
	})
	utils.LogWithFields(utils.LevelDebug, "session.toolgate", "gate request emitted — awaiting client", map[string]any{
		"key": key, "gate_request_id": gateRequestID, "tool": toolName, "sibling_count": len(siblings), "timeout_ms": timeout.Milliseconds(),
	})

	select {
	case reply := <-ch:
		decision := reply.Decision
		if decision != types.GateDecisionDeny {
			// Anything other than an explicit deny is an allow: an
			// unrecognized decision string must not invent a refusal.
			decision = types.GateDecisionAllow
		}
		utils.LogWithFields(utils.LevelInfo, "session.toolgate", "client answered gate", map[string]any{
			"key": key, "gate_request_id": gateRequestID, "tool": toolName,
			"decision": decision, "latency_ms": time.Since(start).Milliseconds(),
		})
		return decision, reply.Reason
	case <-time.After(timeout):
		fallback := gateCfg.ResolveTimeoutDecision()
		utils.LogWithFields(utils.LevelWarn, "session.toolgate", "gate timed out — applying declared fallback", map[string]any{
			"key": key, "gate_request_id": gateRequestID, "tool": toolName,
			"timeout_ms": timeout.Milliseconds(), "fallback": fallback,
		})
		if fallback == types.GateDecisionDeny {
			return types.GateDecisionDeny, fmt.Sprintf(
				"The session's client tool gate did not answer within %dms and the session declared deny-on-timeout, so this call was not executed.",
				timeout.Milliseconds())
		}
		return types.GateDecisionAllow, ""
	}
}

// wireToolGate installs the gate callback on the run config when the session
// opted in. Called from buildRunConfig. A session with no ToolGate (or a
// disabled one) leaves OnToolGate nil, which is the loop's fast path.
func (m *Manager) wireToolGate(s *engineSession, key string, runCfg *backend.RunConfig) {
	gateCfg := s.config.ToolGate
	if gateCfg == nil || !gateCfg.Enabled {
		return
	}
	captured := gateCfg
	runCfg.Hooks.OnToolGate = func(toolName string, input map[string]interface{}, cwd string, siblings []string) (string, string) {
		if !captured.Applies(toolName) {
			return types.GateDecisionAllow, ""
		}
		return m.requestToolGateDecision(key, captured, toolName, input, cwd, siblings)
	}
	utils.LogWithFields(utils.LevelInfo, "session.toolgate", "client tool gate wired", map[string]any{
		"key": key, "tools": captured.Tools, "timeout_ms": captured.ResolveTimeoutMs(),
		"timeout_decision": captured.ResolveTimeoutDecision(),
	})
}

// wireClientTools copies the session-owned client-tool runtime (built by
// buildClientToolRuntime onto opts.ClientTools / opts.ClientToolRouter) into
// the API run's tool list and routing chain. Client tools are the third tool
// provision path beside MCP servers and extensions: the client declares them
// at start_session, the model calls them like any tool, and execution is a
// wire round-trip — engine_tool_gate_request (gateKind "tool") out,
// tool_gate_response (gateContent / gateIsError) back.
//
// Human-wait tools (ClientToolDef.HumanWait) are the exception to the round
// trip: they join the tool list so the model can call them, but their names
// go into RunConfig.HumanWaitClientTools and the runloop PARKS the run on
// invocation (PermissionDenial + terminate — the AskUserQuestion treatment)
// instead of routing the call. The user's answer arrives as the next prompt,
// so the wait survives stop, reconnect, and engine restart.
//
// This is the API-backend adapter over the runtime; the delegated-CLI
// adapters (ToolServer registration, codex dynamicTools) consume the SAME
// opts fields, which is what keeps the transports from drifting.
//
// Called AFTER wireExternalTools so the wrap composes: a name that is not a
// client tool falls through to the prior router (MCP, extensions) untouched.
// Name collisions resolve toward the earlier registration — a client tool
// never shadows an MCP or extension tool, because those are visible in the
// tool list the model already reasons over.
func (m *Manager) wireClientTools(key string, opts *types.RunOptions, runCfg *backend.RunConfig) {
	if len(opts.ClientTools) == 0 || opts.ClientToolRouter == nil {
		return
	}

	existing := make(map[string]bool, len(runCfg.ExternalTools))
	for _, td := range runCfg.ExternalTools {
		existing[td.Name] = true
	}

	clientToolNames := make(map[string]bool, len(opts.ClientTools))
	for _, ct := range opts.ClientTools {
		if existing[ct.Name] {
			utils.LogWithFields(utils.LevelWarn, "session.toolgate", "client tool shadows an existing external tool; skipped", map[string]any{
				"key": key, "tool": ct.Name,
			})
			continue
		}
		// Explicit mapper, not a type conversion: HumanWait is an engine-side
		// execution-policy flag that must never leak into the provider schema.
		runCfg.ExternalTools = append(runCfg.ExternalTools, ct.LlmToolDef())
		clientToolNames[ct.Name] = true
		if ct.HumanWait {
			if runCfg.HumanWaitClientTools == nil {
				runCfg.HumanWaitClientTools = make(map[string]bool)
			}
			runCfg.HumanWaitClientTools[ct.Name] = true
		}
	}
	if len(clientToolNames) == 0 {
		return
	}

	router := opts.ClientToolRouter
	priorRouter := runCfg.McpToolRouter
	runCfg.McpToolRouter = func(ctx context.Context, name string, input map[string]interface{}) (*types.ToolResult, error) {
		if clientToolNames[name] {
			return router(ctx, name, input), nil
		}
		if priorRouter != nil {
			return priorRouter(ctx, name, input)
		}
		return nil, fmt.Errorf("external tool %q not found", name)
	}

	utils.LogWithFields(utils.LevelInfo, "session.toolgate", "client tools wired", map[string]any{
		"key": key, "count": len(clientToolNames), "human_wait_count": len(runCfg.HumanWaitClientTools),
	})
}

// requestClientToolResult emits an engine_tool_gate_request with gateKind
// "tool" and blocks until the client's tool_gate_response carries the result,
// the finite ClientToolTimeoutMs elapses, or the tool context is cancelled.
// Always returns a non-nil ToolResult: a missing client is a tool error the
// model can read, never a hang.
//
// MACHINE tools only. A human-wait declaration (ClientToolDef.HumanWait)
// never reaches this router: the API runloop parks the run on invocation
// (RunConfig.HumanWaitClientTools — PermissionDenial + terminate, the
// AskUserQuestion treatment), and the delegated-CLI adapters exclude
// human-wait tools from their transports entirely. Parking is what lets a
// human answer at their own pace across stop, reconnect, and restart; a
// blocking wire wait cannot survive any of those.
//
// Every pending call is registered on the session for the span of the wait
// (registerClientToolCall / deregisterClientToolCall), which drives the
// engine_client_tool_state snapshot a reconnecting client replays from.
func (m *Manager) requestClientToolResult(
	ctx context.Context,
	key string,
	gateCfg *types.ToolGateConfig,
	def types.ClientToolDef,
	input map[string]interface{},
	cwd string,
) *types.ToolResult {
	toolName := def.Name
	m.mu.RLock()
	s, ok := m.sessions[key]
	var runID string
	if ok {
		runID = s.requestID
	}
	m.mu.RUnlock()
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "session.toolgate", "client tool skipped: session not found", map[string]any{"key": key, "tool": toolName})
		return &types.ToolResult{Content: "client tool unavailable: session is gone", IsError: true}
	}

	gateRequestID := fmt.Sprintf("tool-gate-%d-%d", time.Now().UnixNano(), toolGateSeq.Add(1))
	ch := s.pending.RegisterToolGate(gateRequestID)
	defer s.pending.UnregisterToolGate(gateRequestID)

	// Publish the pending call before the request event so a client that
	// reacts to the event by querying state already sees the entry; the
	// deferred deregister emits the cleared snapshot on every exit path.
	m.registerClientToolCall(key, types.ClientToolCallState{
		RequestID: gateRequestID,
		RunID:     runID,
		ToolName:  toolName,
		ToolInput: input,
		Cwd:       cwd,
		StartedAt: time.Now().UnixMilli(),
	})
	outcome := "fulfilled"
	defer func() { m.deregisterClientToolCall(key, gateRequestID, outcome) }()

	timeout := time.Duration(gateCfg.ResolveClientToolTimeoutMs()) * time.Millisecond
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	start := time.Now()

	m.emit(key, types.EngineEvent{
		Type:          "engine_tool_gate_request",
		GateRequestID: gateRequestID,
		GateKind:      types.GateKindTool,
		GateToolName:  toolName,
		GateToolInput: input,
		GateCwd:       cwd,
	})
	utils.LogWithFields(utils.LevelDebug, "session.toolgate", "client tool request emitted — awaiting fulfillment", map[string]any{
		"key": key, "gate_request_id": gateRequestID, "tool": toolName, "timeout_ms": timeout.Milliseconds(),
	})

	select {
	case reply := <-ch:
		utils.LogWithFields(utils.LevelInfo, "session.toolgate", "client tool fulfilled", map[string]any{
			"key": key, "gate_request_id": gateRequestID, "tool": toolName,
			"is_error": reply.IsError, "content_len": len(reply.Content), "latency_ms": time.Since(start).Milliseconds(),
		})
		return &types.ToolResult{Content: reply.Content, IsError: reply.IsError}
	case <-ctx.Done():
		outcome = "cancelled"
		utils.LogWithFields(utils.LevelInfo, "session.toolgate", "client tool abandoned: tool context done", map[string]any{
			"key": key, "gate_request_id": gateRequestID, "tool": toolName,
		})
		return &types.ToolResult{Content: "client tool cancelled: " + ctx.Err().Error(), IsError: true}
	case <-timer.C:
		outcome = "timeout"
		utils.LogWithFields(utils.LevelWarn, "session.toolgate", "client tool timed out", map[string]any{
			"key": key, "gate_request_id": gateRequestID, "tool": toolName, "timeout_ms": timeout.Milliseconds(),
		})
		return &types.ToolResult{
			Content: fmt.Sprintf("client tool %q did not answer within %dms; the call was not fulfilled", toolName, timeout.Milliseconds()),
			IsError: true,
		}
	}
}
