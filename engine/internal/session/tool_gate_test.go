package session

// Session-side tests for the client tool gate (session/tool_gate.go): the
// wire round-trip through the broker, the declared-timeout fallbacks, the
// unknown-session and stale-response paths, and the wiring predicate on
// EngineConfig.ToolGate. The backend package pins the loop-side enforcement.

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

func gateTestManager(t *testing.T, key string) *Manager {
	t.Helper()
	mgr := NewManager(newMockBackend())
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{key: newCliSession(key)}
	mgr.mu.Unlock()
	return mgr
}

// TestRequestToolGateDecision_DeliversDeny exercises the round-trip: the
// manager emits engine_tool_gate_request with the tool facts, a simulated
// client answers deny via HandleToolGateResponse, and the deny plus its
// reason come back to the caller.
func TestRequestToolGateDecision_DeliversDeny(t *testing.T) {
	key := "gate-rt"
	mgr := gateTestManager(t, key)

	var emitMu sync.Mutex
	var emittedID, emittedTool, emittedCwd, emittedKind string
	var emittedSiblings []string
	mgr.OnEvent(func(emittedKey string, ev types.EngineEvent) {
		if emittedKey != key || ev.Type != "engine_tool_gate_request" {
			return
		}
		emitMu.Lock()
		emittedID, emittedTool, emittedCwd, emittedKind = ev.GateRequestID, ev.GateToolName, ev.GateCwd, ev.GateKind
		emittedSiblings = ev.GateSiblingTools
		emitMu.Unlock()
		go func(reqID string) {
			time.Sleep(2 * time.Millisecond)
			mgr.HandleToolGateResponse(key, reqID, types.GateDecisionDeny, "bench edit refused", "", false, nil)
		}(ev.GateRequestID)
	})

	cfg := &types.ToolGateConfig{Enabled: true, TimeoutMs: 1000}
	decision, reason := mgr.requestToolGateDecision(key, cfg, "Write", map[string]interface{}{"file_path": "/b/x"}, "/b", []string{"Read"})

	if decision != types.GateDecisionDeny {
		t.Errorf("decision: want deny, got %q", decision)
	}
	if reason != "bench edit refused" {
		t.Errorf("reason: want the client's message verbatim, got %q", reason)
	}

	emitMu.Lock()
	defer emitMu.Unlock()
	if emittedTool != "Write" || emittedCwd != "/b" {
		t.Errorf("event carried (%q, %q), want (Write, /b)", emittedTool, emittedCwd)
	}
	if emittedKind != types.GateKindPolicy {
		t.Errorf("gateKind: want policy, got %q", emittedKind)
	}
	if len(emittedSiblings) != 1 || emittedSiblings[0] != "Read" {
		t.Errorf("gateSiblingTools: want [Read], got %v", emittedSiblings)
	}
	if !strings.HasPrefix(emittedID, "tool-gate-") {
		t.Errorf("request ID does not carry the log-greppable prefix: %q", emittedID)
	}
}

// TestRequestToolGateDecision_UnrecognizedDecisionIsAllow pins the safety
// direction: a reply carrying anything other than an explicit deny resolves
// to allow — an unrecognized decision must not invent a refusal.
func TestRequestToolGateDecision_UnrecognizedDecisionIsAllow(t *testing.T) {
	key := "gate-unrec"
	mgr := gateTestManager(t, key)
	mgr.OnEvent(func(emittedKey string, ev types.EngineEvent) {
		if emittedKey != key || ev.Type != "engine_tool_gate_request" {
			return
		}
		go mgr.HandleToolGateResponse(key, ev.GateRequestID, "defer-to-engine", "ignored", "", false, nil)
	})

	cfg := &types.ToolGateConfig{Enabled: true, TimeoutMs: 1000}
	decision, _ := mgr.requestToolGateDecision(key, cfg, "Bash", nil, "/w", nil)
	if decision != types.GateDecisionAllow {
		t.Errorf("unrecognized decision must resolve to allow, got %q", decision)
	}
}

// TestRequestToolGateDecision_TimeoutAppliesDeclaredAllow pins the default
// fallback: nobody answers, and the declared (default) timeout decision is
// allow, so the call proceeds.
func TestRequestToolGateDecision_TimeoutAppliesDeclaredAllow(t *testing.T) {
	key := "gate-to-allow"
	mgr := gateTestManager(t, key)
	// No event callback wired: nobody responds.
	cfg := &types.ToolGateConfig{Enabled: true, TimeoutMs: 20}

	start := time.Now()
	decision, reason := mgr.requestToolGateDecision(key, cfg, "Write", nil, "/w", nil)
	elapsed := time.Since(start)

	if decision != types.GateDecisionAllow || reason != "" {
		t.Errorf("want (allow, \"\"), got (%q, %q)", decision, reason)
	}
	if elapsed < 20*time.Millisecond {
		t.Errorf("timeout fired too early: %s", elapsed)
	}
	if elapsed > 20*time.Millisecond+100*time.Millisecond {
		t.Errorf("timeout fired too late: %s", elapsed)
	}
}

// TestRequestToolGateDecision_TimeoutAppliesDeclaredDeny pins the opt-in
// safety-critical fallback: the session declared deny-on-timeout, so an
// unanswered gate refuses the call with a reason naming the timeout.
func TestRequestToolGateDecision_TimeoutAppliesDeclaredDeny(t *testing.T) {
	key := "gate-to-deny"
	mgr := gateTestManager(t, key)
	cfg := &types.ToolGateConfig{Enabled: true, TimeoutMs: 20, TimeoutDecision: types.GateDecisionDeny}

	decision, reason := mgr.requestToolGateDecision(key, cfg, "Write", nil, "/w", nil)
	if decision != types.GateDecisionDeny {
		t.Errorf("want deny, got %q", decision)
	}
	if !strings.Contains(reason, "did not answer") || !strings.Contains(reason, "20ms") {
		t.Errorf("deny-on-timeout reason must name the timeout: %q", reason)
	}
}

// TestRequestToolGateDecision_UnknownSessionAllowsImmediately defends the
// teardown race: the session vanished between the loop's callback and the
// manager lookup. The gate allows without waiting — the run is dying anyway.
func TestRequestToolGateDecision_UnknownSessionAllowsImmediately(t *testing.T) {
	mgr := NewManager(newMockBackend())
	cfg := &types.ToolGateConfig{Enabled: true, TimeoutMs: 5000}

	start := time.Now()
	decision, _ := mgr.requestToolGateDecision("nonexistent", cfg, "Write", nil, "/w", nil)
	if decision != types.GateDecisionAllow {
		t.Errorf("want allow for unknown session, got %q", decision)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Millisecond {
		t.Errorf("unknown-session path took too long: %s", elapsed)
	}
}

// TestHandleToolGateResponse_UnknownSessionAndStaleRequestAreNoops mirrors
// the early-stop drop semantics: neither an unknown session nor a stale
// (already unregistered) request panics or delivers anywhere.
func TestHandleToolGateResponse_UnknownSessionAndStaleRequestAreNoops(t *testing.T) {
	key := "gate-stale"
	mgr := gateTestManager(t, key)
	mgr.HandleToolGateResponse("nonexistent", "req-x", types.GateDecisionDeny, "late", "", false, nil)

	s := mgr.sessions[key]
	s.pending.RegisterToolGate("stale")
	s.pending.UnregisterToolGate("stale")
	mgr.HandleToolGateResponse(key, "stale", types.GateDecisionDeny, "late", "", false, nil)
}

// TestWireToolGate_OptInPredicate pins the wiring contract: no ToolGate (or a
// disabled one) leaves OnToolGate nil — the universal fast path — and an
// enabled one installs a callback that respects the Tools narrowing without a
// wire round-trip for ungated tools.
func TestWireToolGate_OptInPredicate(t *testing.T) {
	key := "gate-wire"
	mgr := gateTestManager(t, key)
	s := mgr.sessions[key]

	var runCfg backend.RunConfig
	mgr.wireToolGate(s, key, &runCfg)
	if runCfg.Hooks.OnToolGate != nil {
		t.Fatal("nil ToolGate must leave OnToolGate nil")
	}

	s.config.ToolGate = &types.ToolGateConfig{Enabled: false}
	mgr.wireToolGate(s, key, &runCfg)
	if runCfg.Hooks.OnToolGate != nil {
		t.Fatal("disabled ToolGate must leave OnToolGate nil")
	}

	s.config.ToolGate = &types.ToolGateConfig{Enabled: true, Tools: []string{"Write", "Edit"}, TimeoutMs: 20}
	mgr.wireToolGate(s, key, &runCfg)
	if runCfg.Hooks.OnToolGate == nil {
		t.Fatal("enabled ToolGate must install OnToolGate")
	}

	// An ungated tool resolves allow instantly — no event, no wait.
	start := time.Now()
	decision, _ := runCfg.Hooks.OnToolGate("Read", nil, "/w", nil)
	if decision != types.GateDecisionAllow {
		t.Errorf("ungated tool: want allow, got %q", decision)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Millisecond {
		t.Errorf("ungated tool paid a wait: %s", elapsed)
	}

	// A gated tool goes through the wire path (and times out to allow here).
	decision, _ = runCfg.Hooks.OnToolGate("Write", nil, "/w", nil)
	if decision != types.GateDecisionAllow {
		t.Errorf("gated tool with no responder: want allow-on-timeout, got %q", decision)
	}
}

// TestWireClientTools_AddsToolsAndRoutesFulfillment pins the client-tool
// provision path end to end at the session layer: declared tools join
// ExternalTools, a call routes through the wire round-trip (gateKind "tool"),
// and the client's content lands in the ToolResult.
func TestWireClientTools_AddsToolsAndRoutesFulfillment(t *testing.T) {
	key := "gate-ct"
	mgr := gateTestManager(t, key)
	s := mgr.sessions[key]
	s.config.ToolGate = &types.ToolGateConfig{
		Enabled: true,
		ClientTools: []types.ClientToolDef{
			{Name: "BenchMemberFile", Description: "read a member file", PlanModeSafe: true},
		},
		ClientToolTimeoutMs: 1000,
	}

	mgr.OnEvent(func(emittedKey string, ev types.EngineEvent) {
		if emittedKey != key || ev.Type != "engine_tool_gate_request" {
			return
		}
		if ev.GateKind != types.GateKindTool {
			t.Errorf("gateKind: want tool, got %q", ev.GateKind)
		}
		go mgr.HandleToolGateResponse(key, ev.GateRequestID, "", "", "file contents here", false, nil)
	})

	var runCfg backend.RunConfig
	wireClientToolsForTest(mgr, s, key, &runCfg)

	if len(runCfg.ExternalTools) != 1 || runCfg.ExternalTools[0].Name != "BenchMemberFile" {
		t.Fatalf("ExternalTools: want [BenchMemberFile], got %+v", runCfg.ExternalTools)
	}
	if !runCfg.ExternalTools[0].PlanModeSafe {
		t.Error("PlanModeSafe must carry through to the tool def")
	}
	if runCfg.McpToolRouter == nil {
		t.Fatal("router must be installed")
	}

	result, err := runCfg.McpToolRouter(context.Background(), "BenchMemberFile", map[string]interface{}{"file": "x"})
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || result.IsError || result.Content != "file contents here" {
		t.Errorf("fulfillment result: want client content, got %+v", result)
	}
}

// TestWireClientTools_TimeoutIsToolError pins the missing-client path: an
// unfulfilled client tool returns a tool error naming the timeout, never a
// hang and never a silent empty success.
func TestWireClientTools_TimeoutIsToolError(t *testing.T) {
	key := "gate-ct-timeout"
	mgr := gateTestManager(t, key)
	s := mgr.sessions[key]
	s.config.ToolGate = &types.ToolGateConfig{
		Enabled:             true,
		ClientTools:         []types.ClientToolDef{{Name: "SlowTool"}},
		ClientToolTimeoutMs: 20,
	}

	var runCfg backend.RunConfig
	wireClientToolsForTest(mgr, s, key, &runCfg)

	result, err := runCfg.McpToolRouter(context.Background(), "SlowTool", nil)
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || !result.IsError || !strings.Contains(result.Content, "20ms") {
		t.Errorf("timeout result must be a tool error naming the bound, got %+v", result)
	}
}

// TestWireClientTools_FallsThroughToPriorRouter pins composition: a name that
// is not a client tool reaches the pre-existing router (MCP/extensions).
func TestWireClientTools_FallsThroughToPriorRouter(t *testing.T) {
	key := "gate-ct-chain"
	mgr := gateTestManager(t, key)
	s := mgr.sessions[key]
	s.config.ToolGate = &types.ToolGateConfig{
		Enabled:     true,
		ClientTools: []types.ClientToolDef{{Name: "ClientOnly"}},
	}

	var runCfg backend.RunConfig
	priorCalled := false
	runCfg.McpToolRouter = func(_ context.Context, name string, _ map[string]interface{}) (*types.ToolResult, error) {
		priorCalled = true
		return &types.ToolResult{Content: "from prior router: " + name}, nil
	}
	wireClientToolsForTest(mgr, s, key, &runCfg)

	result, err := runCfg.McpToolRouter(context.Background(), "mcp__srv__tool", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !priorCalled || result.Content != "from prior router: mcp__srv__tool" {
		t.Errorf("non-client tool must fall through, got %+v", result)
	}
}

// TestWireClientTools_NeverShadowsExistingTool pins collision resolution: a
// client tool whose name matches an existing external tool is skipped, and
// the existing tool keeps its routing.
func TestWireClientTools_NeverShadowsExistingTool(t *testing.T) {
	key := "gate-ct-shadow"
	mgr := gateTestManager(t, key)
	s := mgr.sessions[key]
	s.config.ToolGate = &types.ToolGateConfig{
		Enabled:     true,
		ClientTools: []types.ClientToolDef{{Name: "ExistingTool"}},
	}

	var runCfg backend.RunConfig
	runCfg.ExternalTools = []types.LlmToolDef{{Name: "ExistingTool", Description: "extension-owned"}}
	runCfg.McpToolRouter = func(_ context.Context, _ string, _ map[string]interface{}) (*types.ToolResult, error) {
		return &types.ToolResult{Content: "extension answered"}, nil
	}
	wireClientToolsForTest(mgr, s, key, &runCfg)

	if len(runCfg.ExternalTools) != 1 {
		t.Fatalf("shadowed client tool must not duplicate the def: %+v", runCfg.ExternalTools)
	}
	result, err := runCfg.McpToolRouter(context.Background(), "ExistingTool", nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Content != "extension answered" {
		t.Errorf("existing tool must keep its routing, got %+v", result)
	}
}

// TestClientToolResult_PreservesImagesAndExtensionOrigin pins the generic
// client-tool response path: a client-provided base64 image reaches ToolResult
// and an extension SDK invocation is identified on the request event.
func TestClientToolResult_PreservesImagesAndExtensionOrigin(t *testing.T) {
	key := "gate-client-image"
	mgr := gateTestManager(t, key)
	mgr.sessions[key].config.ToolGate = &types.ToolGateConfig{
		Enabled:             true,
		ClientToolTimeoutMs: 1000,
		ClientTools:         []types.ClientToolDef{{Name: "BrowserScreenshot"}},
	}

	mgr.OnEvent(func(emittedKey string, ev types.EngineEvent) {
		if emittedKey != key || ev.Type != "engine_tool_gate_request" || ev.GateKind != types.GateKindTool {
			return
		}
		if ev.GateOrigin != types.GateOriginExtension {
			t.Errorf("gate origin = %q, want extension", ev.GateOrigin)
		}
		go mgr.HandleToolGateResponse(key, ev.GateRequestID, "", "", "screenshot captured", false, []types.ImageAttachment{{
			MediaType: "image/png",
			Data:      "cG5nLWJ5dGVz",
		}})
	})

	result, handled := mgr.callClientToolFromExtension(context.Background(), key, "BrowserScreenshot", map[string]interface{}{"fullPage": true})
	if !handled {
		t.Fatal("declared client tool was not routed")
	}
	if result == nil || result.IsError || result.Content != "screenshot captured" {
		t.Fatalf("result = %#v", result)
	}
	if len(result.Images) != 1 || result.Images[0].MediaType != "image/png" || result.Images[0].Data != "cG5nLWJ5dGVz" {
		t.Fatalf("client image lost from result: %#v", result.Images)
	}
}
