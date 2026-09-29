package telemetry

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestTelemetryAttributesActingPrincipal pins R-41: an event emitted with
// ctx carrying "principal_identity" stamps that identity on the event,
// regardless of what the process-wide SetUserIdentity value is.
func TestTelemetryAttributesActingPrincipal(t *testing.T) {
	SetUserIdentity("process-wide-operator")
	t.Cleanup(func() { SetUserIdentity("") })

	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	c.Event("test.event", map[string]any{"x": 1}, map[string]any{"principal_identity": "alice"})

	events := c.BufferedEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].User != "alice" {
		t.Errorf("User = %q, want %q (the context-carried principal, not the process-wide value)", events[0].User, "alice")
	}
}

// TestTelemetryFallsBackToProcessIdentity pins B-23: an event with no
// principal_identity in ctx (or nil ctx) falls back to the process-wide
// SetUserIdentity value exactly as before this program.
func TestTelemetryFallsBackToProcessIdentity(t *testing.T) {
	SetUserIdentity("process-wide-operator")
	t.Cleanup(func() { SetUserIdentity("") })

	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	c.Event("test.event", map[string]any{"x": 1}, nil)
	c.Event("test.event2", map[string]any{"x": 2}, map[string]any{"run_id": "r1"})

	events := c.BufferedEvents()
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
	for _, e := range events {
		if e.User != "process-wide-operator" {
			t.Errorf("event %q User = %q, want the process-wide fallback", e.Name, e.User)
		}
	}
}

// TestConcurrentPrincipalsAttributeCorrectly pins R-47: two goroutines
// emitting events with different principal_identity context values never
// cross -- each event carries exactly its own emitter's identity.
func TestConcurrentPrincipalsAttributeCorrectly(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})

	const perGoroutine = 50
	var wg sync.WaitGroup
	emit := func(identity string) {
		defer wg.Done()
		for i := 0; i < perGoroutine; i++ {
			c.Event("test.concurrent", map[string]any{"i": i}, map[string]any{"principal_identity": identity})
		}
	}
	wg.Add(2)
	go emit("alice")
	go emit("bob")
	wg.Wait()

	events := c.BufferedEvents()
	if len(events) != 2*perGoroutine {
		t.Fatalf("expected %d events, got %d", 2*perGoroutine, len(events))
	}
	aliceCount, bobCount, crossed := 0, 0, 0
	for _, e := range events {
		switch e.User {
		case "alice":
			aliceCount++
		case "bob":
			bobCount++
		default:
			crossed++
		}
	}
	if crossed != 0 {
		t.Errorf("expected zero crossings, got %d events with an unexpected identity", crossed)
	}
	if aliceCount != perGoroutine || bobCount != perGoroutine {
		t.Errorf("expected %d events each, got alice=%d bob=%d", perGoroutine, aliceCount, bobCount)
	}
}

// TestTelemetryAndLogAgreeOnIdentity pins that identityForEvent's resolution
// (context-first, process-fallback) is the SAME resolution
// resolvedEgressUser (logger_ambient.go, utils package) uses, so a
// telemetry event and its corresponding log lines correlate to the same
// identity. This test pins the telemetry side's contract in isolation
// (resolvedEgressUser is exercised by its own package's tests); the shared
// contract is: context value wins, process value is the fallback, both
// resolved by inspecting a per-emit source before a process-wide atomic.
func TestTelemetryAndLogAgreeOnIdentity(t *testing.T) {
	SetUserIdentity("process-wide")
	t.Cleanup(func() { SetUserIdentity("") })

	withContext := identityForEvent(map[string]any{"principal_identity": "alice"})
	if withContext != "alice" {
		t.Errorf("identityForEvent with context = %q, want alice", withContext)
	}
	withoutContext := identityForEvent(nil)
	if withoutContext != "process-wide" {
		t.Errorf("identityForEvent with no context = %q, want the process-wide fallback", withoutContext)
	}
}

// TestTelemetryNeverCarriesClaims pins the identity gate: SessionPrincipal's
// AttributionForTelemetry (the ONLY path that feeds identityForEvent's
// context key) never returns Claims -- verified by constructing a principal
// with real-looking Claims and asserting the returned string never contains
// them, and structurally, that AttributionForTelemetry's signature returns a
// bare string (Claims is a map and could never be returned as one anyway).
func TestTelemetryNeverCarriesClaims(t *testing.T) {
	p := &types.SessionPrincipal{
		Subject: "oidc:alice",
		Claims:  map[string]any{"roles": []string{"admin"}, "tenant": "secret-tenant-id"},
	}
	attribution := p.AttributionForTelemetry()
	if attribution != "oidc:alice" {
		t.Errorf("AttributionForTelemetry() = %q, want the Subject fallback", attribution)
	}
	// Claims must never appear in the attribution string by construction --
	// AttributionForTelemetry only ever reads Attribution/DisplayName/Subject.
}
