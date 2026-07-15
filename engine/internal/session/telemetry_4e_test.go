package session

import (
	"errors"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestExtensionRespawnTelemetry verifies emitExtensionRespawnTelemetry emits an
// extension.respawn event with the correct outcome for each terminal state.
// Uses a real telemetry.Collector and BufferedEvents(). Goes red if the emit is
// removed from respawnDeadExtensions (the helper is the single emit site).
func TestExtensionRespawnTelemetry(t *testing.T) {
	cases := []struct {
		name        string
		err         error
		wantOutcome string
	}{
		{"success", nil, "respawned"},
		{"budget", extension.ErrBudgetExceeded, "budget_exceeded"},
		{"failure", errors.New("spawn boom"), "spawn_failed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := &Manager{}
			col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
			s := &engineSession{key: "sess-respawn", telemetry: col}
			h := extension.NewHost()

			m.emitExtensionRespawnTelemetry(s, "sess-respawn", h, 2, tc.err)

			var found *telemetry.Event
			for i, e := range col.BufferedEvents() {
				if e.Name == telemetry.ExtensionRespawn {
					ev := col.BufferedEvents()[i]
					found = &ev
					break
				}
			}
			if found == nil {
				t.Fatal("expected an extension.respawn event")
			}
			if found.Payload["outcome"] != tc.wantOutcome {
				t.Errorf("outcome = %v, want %v", found.Payload["outcome"], tc.wantOutcome)
			}
			if found.Payload["attempt"] != 2 {
				t.Errorf("attempt = %v, want 2", found.Payload["attempt"])
			}
			if found.Payload["budget_max"] != h.RespawnBudget() {
				t.Errorf("budget_max = %v, want %d", found.Payload["budget_max"], h.RespawnBudget())
			}
			if found.Context["session_id"] != "sess-respawn" {
				t.Errorf("ctx session_id = %v", found.Context["session_id"])
			}
		})
	}
}

// TestExtensionRespawnTelemetryNilCollector verifies the emit is a no-op when
// the session has no telemetry collector.
func TestExtensionRespawnTelemetryNilCollector(t *testing.T) {
	m := &Manager{}
	s := &engineSession{key: "sess-nil"}
	h := extension.NewHost()
	// Must not panic.
	m.emitExtensionRespawnTelemetry(s, "sess-nil", h, 1, nil)
}

// TestExtensionColdstartTelemetry verifies emitExtensionColdstartTelemetry
// emits an extension.coldstart event with the transpiled_ts flag reflecting the
// entry-point extension.
func TestExtensionColdstartTelemetry(t *testing.T) {
	m := &Manager{}
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	s := &engineSession{key: "sess-cold", telemetry: col}
	h := extension.NewHost()

	m.emitExtensionColdstartTelemetry(s, "sess-cold", h, "/path/to/ext/index.ts")

	var found *telemetry.Event
	events := col.BufferedEvents()
	for i := range events {
		if events[i].Name == telemetry.ExtensionColdstart {
			found = &events[i]
			break
		}
	}
	if found == nil {
		t.Fatal("expected an extension.coldstart event")
	}
	if found.Payload["cold"] != true {
		t.Errorf("cold = %v, want true", found.Payload["cold"])
	}
	if found.Payload["transpiled_ts"] != true {
		t.Errorf("transpiled_ts = %v, want true for .ts entry", found.Payload["transpiled_ts"])
	}
	if _, ok := found.Payload["ready_ms"].(int64); !ok {
		t.Errorf("ready_ms missing/wrong type: %v", found.Payload["ready_ms"])
	}

	// A .js entry point reports transpiled_ts false.
	col2 := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	s2 := &engineSession{key: "sess-cold-js", telemetry: col2}
	m.emitExtensionColdstartTelemetry(s2, "sess-cold-js", h, "/path/to/ext/index.js")
	var foundJS *telemetry.Event
	ev2 := col2.BufferedEvents()
	for i := range ev2 {
		if ev2[i].Name == telemetry.ExtensionColdstart {
			foundJS = &ev2[i]
			break
		}
	}
	if foundJS == nil {
		t.Fatal("expected a .js extension.coldstart event")
	}
	if foundJS.Payload["transpiled_ts"] != false {
		t.Errorf("transpiled_ts = %v, want false for .js entry", foundJS.Payload["transpiled_ts"])
	}
}

// TestExtensionRespawnTelemetry_CorrelationCtx asserts that extension.respawn
// carries conversation_id in its correlation context. Regression for the site
// that previously emitted only {"session_id": key}: against the pre-fix code,
// the conversation_id assertion fails because the key was never set.
func TestExtensionRespawnTelemetry_CorrelationCtx(t *testing.T) {
	m := &Manager{}
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	const wantConvID = "conv-respawn-789"
	s := &engineSession{key: "sess-respawn-ctx", telemetry: col, conversationID: wantConvID}
	h := extension.NewHost()

	m.emitExtensionRespawnTelemetry(s, "sess-respawn-ctx", h, 1, nil)

	events := col.BufferedEvents()
	var found *telemetry.Event
	for i := range events {
		if events[i].Name == telemetry.ExtensionRespawn {
			found = &events[i]
			break
		}
	}
	if found == nil {
		t.Fatal("expected an extension.respawn event")
	}
	if got := found.Context["session_id"]; got != "sess-respawn-ctx" {
		t.Errorf("context session_id = %v, want sess-respawn-ctx", got)
	}
	if got := found.Context["conversation_id"]; got != wantConvID {
		t.Errorf("context conversation_id = %v, want %q", got, wantConvID)
	}
}

// TestExtensionColdstartTelemetry_CorrelationCtx asserts that extension.coldstart
// carries conversation_id in its correlation context. Regression for the site
// that previously emitted only {"session_id": key}: against the pre-fix code,
// the conversation_id assertion fails because the key was never set.
func TestExtensionColdstartTelemetry_CorrelationCtx(t *testing.T) {
	m := &Manager{}
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	const wantConvID = "conv-coldstart-abc"
	s := &engineSession{key: "sess-cold-ctx", telemetry: col, conversationID: wantConvID}
	h := extension.NewHost()

	m.emitExtensionColdstartTelemetry(s, "sess-cold-ctx", h, "/ext/index.ts")

	events := col.BufferedEvents()
	var found *telemetry.Event
	for i := range events {
		if events[i].Name == telemetry.ExtensionColdstart {
			found = &events[i]
			break
		}
	}
	if found == nil {
		t.Fatal("expected an extension.coldstart event")
	}
	if got := found.Context["session_id"]; got != "sess-cold-ctx" {
		t.Errorf("context session_id = %v, want sess-cold-ctx", got)
	}
	if got := found.Context["conversation_id"]; got != wantConvID {
		t.Errorf("context conversation_id = %v, want %q", got, wantConvID)
	}
}
