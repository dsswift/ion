package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// findEvent returns the first buffered event with the given name, or nil.
func findEvent(col *telemetry.Collector, name string) *telemetry.Event {
	for i, e := range col.BufferedEvents() {
		if e.Name == name {
			ev := col.BufferedEvents()[i]
			return &ev
		}
	}
	return nil
}

// TestEnforcement_ToolBlocked_EmitsAuditEvent pins the feature 0010 audit
// clause: when the enterprise tool gate blocks a call, an
// enforcement.tool_blocked telemetry event is emitted. Red on unfixed code
// (the gate blocked but emitted nothing).
func TestEnforcement_ToolBlocked_EmitsAuditEvent(t *testing.T) {
	apiBackend := backend.NewApiBackend()
	mgr := NewManager(apiBackend)
	defer mgr.Shutdown()
	mgr.SetConfig(enterpriseDenyBash())

	s := newPlainTestSession("aud1")
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"aud1": s}
	mgr.mu.Unlock()

	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	runCfg := mgr.buildRunConfig(s, "aud1", "req-1", apiBackend, nil, false, nil, col, nil, "")

	if runCfg.Hooks.OnToolCall == nil {
		t.Fatal("expected enterprise tool gate installed")
	}
	result, err := runCfg.Hooks.OnToolCall(backend.ToolCallInfo{ToolName: "Bash", ToolID: "t1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil || !result.Block {
		t.Fatal("expected Bash blocked")
	}

	ev := findEvent(col, telemetry.EnforcementToolBlocked)
	if ev == nil {
		t.Fatal("expected enforcement.tool_blocked audit event")
	}
	if ev.Payload["subject"] != "Bash" {
		t.Errorf("subject = %v, want Bash", ev.Payload["subject"])
	}
	if ev.Payload["source"] != "denylist" {
		t.Errorf("source = %v, want denylist", ev.Payload["source"])
	}

	// Non-denied tool emits no event.
	before := len(col.BufferedEvents())
	if _, err := runCfg.Hooks.OnToolCall(backend.ToolCallInfo{ToolName: "Read", ToolID: "t2"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(col.BufferedEvents()) != before {
		t.Error("allowed tool must not emit an enforcement event")
	}
}

// TestEnforcement_SessionLimit_EmitsAuditEvent pins that a session-limit
// rejection emits enforcement.session_limit through the process collector.
func TestEnforcement_SessionLimit_EmitsAuditEvent(t *testing.T) {
	limit := 1
	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()
	mgr.SetConfig(&types.EngineRuntimeConfig{
		ResourceLimits: &types.ResourceLimits{MaxSessions: &limit},
	})
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	mgr.SetProcessTelemetry(col)

	if _, err := mgr.StartSession("s1", types.EngineConfig{}); err != nil {
		t.Fatalf("first session should start: %v", err)
	}
	if _, err := mgr.StartSession("s2", types.EngineConfig{}); err == nil {
		t.Fatal("second session must be rejected at MaxSessions=1")
	}

	ev := findEvent(col, telemetry.EnforcementSessionLimit)
	if ev == nil {
		t.Fatal("expected enforcement.session_limit audit event")
	}
	if ev.Payload["source"] != "limit" {
		t.Errorf("source = %v, want limit", ev.Payload["source"])
	}
	if ev.Payload["subject"] != "s2" {
		t.Errorf("subject = %v, want s2", ev.Payload["subject"])
	}
}
