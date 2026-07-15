package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestWirePermissionDecisionTelemetry_CtxFields asserts that the
// permission.decision event emitted by wirePermissionDecisionTelemetry carries:
//   - ctx["session_id"]      == the engineSession's key (not the audit session ID)
//   - ctx["conversation_id"] == the engineSession's conversationID
//   - payload["audit_session_id"] == entry.SessionID (the audit-layer ID)
//
// This is the canonical test for the fix that moved entry.SessionID out of ctx
// and into payload so that ctx["session_id"] carries the canonical session key.
func TestWirePermissionDecisionTelemetry_CtxFields(t *testing.T) {
	const (
		sessionKey     = "sess-key-abc"
		convID         = "conv-id-xyz"
		auditSessionID = "audit-sess-999"
	)

	// Build a minimal engineSession with a real permission engine and a
	// telemetry collector backed by an in-memory-only config (no file I/O).
	permEng := permissions.NewEngine(nil)
	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})

	sess := &engineSession{
		key:            sessionKey,
		conversationID: convID,
		permEngine:     permEng,
		telemetry:      collector,
	}

	// wirePermissionDecisionTelemetry is the method under test. It registers
	// an OnAudit callback; invoking permEng.Check triggers the callback.
	m := &Manager{}
	m.wirePermissionDecisionTelemetry(sess)

	// Fire a synthetic audit entry by triggering a permission check. We call
	// the engine directly via Check so the AuditEntry is populated through
	// the real path. Use a tool name that will be allowed by the default
	// (empty) config so the check completes and the entry is emitted.
	info := permissions.CheckInfo{
		Tool:      "Read",
		Input:     map[string]interface{}{"path": "/tmp/test"},
		SessionID: auditSessionID,
	}
	permEng.Check(info)

	// Retrieve the buffered event without flushing (BufferedEvents is the
	// approved test seam for inspecting recorded events without side effects).
	events := collector.BufferedEvents()
	if len(events) == 0 {
		t.Fatal("expected at least one buffered telemetry event, got none")
	}

	// Find the permission.decision event.
	var found *telemetry.Event
	for i := range events {
		if events[i].Name == telemetry.PermissionDecision {
			found = &events[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("no %q event found in buffered events: %v", telemetry.PermissionDecision, events)
	}

	// --- ctx assertions ---

	gotSessionID, ok := found.Context["session_id"]
	if !ok {
		t.Fatal("ctx missing session_id")
	}
	if gotSessionID != sessionKey {
		t.Errorf("ctx session_id = %q, want %q (the session key, not the audit session ID)", gotSessionID, sessionKey)
	}

	gotConvID, ok := found.Context["conversation_id"]
	if !ok {
		t.Fatal("ctx missing conversation_id")
	}
	if gotConvID != convID {
		t.Errorf("ctx conversation_id = %q, want %q", gotConvID, convID)
	}

	// session_id must NOT be the audit session ID.
	if gotSessionID == auditSessionID {
		t.Errorf("ctx session_id is the audit session ID %q; want the canonical session key", auditSessionID)
	}

	// --- payload assertions ---

	gotAuditID, ok := found.Payload["audit_session_id"]
	if !ok {
		t.Fatal("payload missing audit_session_id")
	}
	if gotAuditID != auditSessionID {
		t.Errorf("payload audit_session_id = %q, want %q", gotAuditID, auditSessionID)
	}
}

// TestWirePermissionDecisionTelemetry_NilGuards verifies the function is
// nil-safe for the two early-exit paths documented in the source.
func TestWirePermissionDecisionTelemetry_NilGuards(t *testing.T) {
	m := &Manager{}

	// nil session must not panic.
	m.wirePermissionDecisionTelemetry(nil)

	// nil permEngine must not panic.
	m.wirePermissionDecisionTelemetry(&engineSession{})
}

// TestWirePermissionDecisionTelemetry_LatencyIsFractionalFloat pins that the
// decision_latency_ms payload field is emitted as a sub-millisecond float64,
// not an integer millisecond. The fast permission rails (allow_mode, etc.)
// resolve in microseconds; the pre-fix emission read entry.LatencyMs
// (time.Since(...).Milliseconds()) which floored those to integer 0, blanking
// the decision-latency panel. This test asserts the payload value is a float64
// and >= 0 — it fails on the pre-fix int64 emission on the type assertion.
func TestWirePermissionDecisionTelemetry_LatencyIsFractionalFloat(t *testing.T) {
	permEng := permissions.NewEngine(nil)
	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})

	sess := &engineSession{
		key:            "sess-latency",
		conversationID: "conv-latency",
		permEngine:     permEng,
		telemetry:      collector,
	}

	m := &Manager{}
	m.wirePermissionDecisionTelemetry(sess)

	permEng.Check(permissions.CheckInfo{
		Tool:      "Read",
		Input:     map[string]interface{}{"path": "/tmp/test"},
		SessionID: "audit-latency",
	})

	events := collector.BufferedEvents()
	var found *telemetry.Event
	for i := range events {
		if events[i].Name == telemetry.PermissionDecision {
			found = &events[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("no %q event found", telemetry.PermissionDecision)
	}

	raw, ok := found.Payload["decision_latency_ms"]
	if !ok {
		t.Fatal("payload missing decision_latency_ms")
	}
	// Must be a float64: sub-millisecond precision requires a float. The pre-fix
	// int64 emission fails this type assertion outright.
	latency, ok := raw.(float64)
	if !ok {
		t.Fatalf("decision_latency_ms = %T, want float64 (sub-ms precision requires a float)", raw)
	}
	if latency < 0 {
		t.Errorf("decision_latency_ms = %v, want >= 0", latency)
	}
}
