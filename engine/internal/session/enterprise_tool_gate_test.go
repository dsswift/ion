package session

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/types"
)

// Tests for D-009: enterprise tool restrictions enforced on EVERY session,
// including plain (extension-less) conversations.
//
// Background: the enterprise OnToolCall check historically lived only inside
// wireExtensionHooks, which runs only when an extension group attaches. A
// plain conversation never installed the callback, so enterprise
// ToolRestrictions silently did not apply — the plain-session bypass. The fix
// installs the enterprise gate unconditionally in buildRunConfig; extension
// hooks compose ON TOP of it (enterprise first, extension second).
//
// Regression discipline: TestPlainSession_EnterpriseToolDeny_Blocks FAILS on
// the unfixed code (no OnToolCall would be installed for a plain session) and
// passes on the fixed code.

func newPlainTestSession(key string) *engineSession {
	return &engineSession{
		key:       key,
		config:    defaultConfig(),
		agents:    agents.NewRegistry(),
		childPIDs: make(map[int]struct{}),
		pending:   pending.New(),
	}
}

func enterpriseDenyBash() *types.EngineRuntimeConfig {
	return &types.EngineRuntimeConfig{
		Enterprise: &types.EnterpriseConfig{
			ToolRestrictions: &types.ToolRestrictions{
				Deny: []string{"Bash"},
			},
		},
	}
}

// TestPlainSession_EnterpriseToolDeny_Blocks pins the D-009 fix: a session
// with NO extension group still enforces enterprise ToolRestrictions.
func TestPlainSession_EnterpriseToolDeny_Blocks(t *testing.T) {
	apiBackend := backend.NewApiBackend()
	mgr := NewManager(apiBackend)
	defer mgr.Shutdown()
	mgr.SetConfig(enterpriseDenyBash())

	s := newPlainTestSession("plain1")
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"plain1": s}
	mgr.mu.Unlock()

	// Plain session: nil extension group.
	runCfg := mgr.buildRunConfig(s, "plain1", "req-1", apiBackend, nil, false, nil, nil, nil, "")

	if runCfg.Hooks.OnToolCall == nil {
		t.Fatal("plain session must install the enterprise OnToolCall gate (D-009 bypass regression)")
	}

	// Denied tool is blocked.
	result, err := runCfg.Hooks.OnToolCall(backend.ToolCallInfo{ToolName: "Bash", ToolID: "t1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil || !result.Block {
		t.Fatal("expected Bash to be blocked by enterprise policy on a plain session")
	}
	if !strings.Contains(result.Reason, "enterprise policy") {
		t.Errorf("block reason should cite enterprise policy, got %q", result.Reason)
	}

	// Non-denied tool passes.
	result, err = runCfg.Hooks.OnToolCall(backend.ToolCallInfo{ToolName: "Read", ToolID: "t2"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil && result.Block {
		t.Error("Read is not denied and must pass the enterprise gate")
	}
}

// TestPlainSession_NoEnterprise_NoToolGate pins the open-source default: with
// no enterprise config, a plain session installs no OnToolCall gate at all.
func TestPlainSession_NoEnterprise_NoToolGate(t *testing.T) {
	apiBackend := backend.NewApiBackend()
	mgr := NewManager(apiBackend)
	defer mgr.Shutdown()
	mgr.SetConfig(&types.EngineRuntimeConfig{}) // no Enterprise block

	s := newPlainTestSession("plain2")
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"plain2": s}
	mgr.mu.Unlock()

	runCfg := mgr.buildRunConfig(s, "plain2", "req-1", apiBackend, nil, false, nil, nil, nil, "")

	if runCfg.Hooks.OnToolCall != nil {
		t.Error("without enterprise config a plain session must not install an OnToolCall gate")
	}
}

// TestExtensionSession_EnterpriseGateComposesWithExtensionHook verifies the
// two-layer composition: enterprise policy evaluates first and blocks
// unconditionally; when enterprise passes, the extension tool_call hook
// evaluates second and can add its own (stricter) block.
func TestExtensionSession_EnterpriseGateComposesWithExtensionHook(t *testing.T) {
	apiBackend := backend.NewApiBackend()
	mgr := NewManager(apiBackend)
	defer mgr.Shutdown()
	mgr.SetConfig(enterpriseDenyBash())

	s := newPlainTestSession("ext1")
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"ext1": s}
	mgr.mu.Unlock()

	// Extension blocks "Edit" (stricter than enterprise, which denies only Bash).
	host := extension.NewHost()
	host.SDK().On(extension.HookToolCall, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		info := payload.(extension.ToolCallInfo)
		if info.ToolName == "Edit" {
			return &extension.ToolCallResult{Block: true, Reason: "extension says no Edit"}, nil
		}
		return nil, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)
	s.extGroup = group

	runCfg := mgr.buildRunConfig(s, "ext1", "req-1", apiBackend, group, false, nil, nil, nil, "")

	if runCfg.Hooks.OnToolCall == nil {
		t.Fatal("extension session must have OnToolCall wired")
	}

	// Layer 1: enterprise deny fires first.
	result, err := runCfg.Hooks.OnToolCall(backend.ToolCallInfo{ToolName: "Bash", ToolID: "t1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil || !result.Block {
		t.Fatal("enterprise-denied Bash must be blocked on an extension session")
	}
	if !strings.Contains(result.Reason, "enterprise policy") {
		t.Errorf("Bash block must come from the enterprise layer, got %q", result.Reason)
	}

	// Layer 2: extension deny fires when enterprise passes.
	result, err = runCfg.Hooks.OnToolCall(backend.ToolCallInfo{ToolName: "Edit", ToolID: "t2"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil || !result.Block {
		t.Fatal("extension-denied Edit must be blocked")
	}
	if !strings.Contains(result.Reason, "extension says no Edit") {
		t.Errorf("Edit block must come from the extension layer, got %q", result.Reason)
	}

	// Both layers pass: tool proceeds.
	result, err = runCfg.Hooks.OnToolCall(backend.ToolCallInfo{ToolName: "Read", ToolID: "t3"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil && result.Block {
		t.Error("Read passes both layers and must not be blocked")
	}
}
