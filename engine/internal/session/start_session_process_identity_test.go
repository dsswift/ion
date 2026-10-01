package session

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestStartSessionPromotesPrincipalToProcessWideIdentity pins the origin fix
// for gap 2 of the telemetry user-identity defect (374aed82d fixed gap 1,
// dispatch.agent only).
//
// On a desktop install the engine runs its own OIDC login
// (auth.identityProvider); signing in populates the process-wide
// resolvedUserIdentity() (server/dispatch_oidc.go's broadcastOidcIdentity),
// so extension.coldstart/extension.respawn/extension.hook_latency/
// system.metrics -- all built from a ctx with no "principal_identity" key
// (correlationCtx/correlationCtxExt never carry it, or the ctx is nil) --
// still carry a user via identityForEvent's fallback.
//
// On an Atlas instance pod the owner authenticates through the SERVER's own
// OIDC door (server.json's oidc config, the bearer auth door) -- engine.json
// carries no identityProvider there -- so nothing ever called
// telemetry.SetUserIdentity, and those same events shipped with an empty
// user forever, even though the server told the engine exactly who is
// signed in on every start_session (types.SessionPrincipal).
//
// RED on unfixed code: Event.User for a process-level event emitted after
// StartSession with a server-supplied principal (simulating the pod's
// bearer-authenticated owner) is "" instead of the principal's attribution.
func TestStartSessionPromotesPrincipalToProcessWideIdentity(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	telemetry.SetUserIdentity("")
	t.Cleanup(func() { telemetry.SetUserIdentity("") })

	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	mgr.SetHeartbeatInterval(10 * time.Minute)

	principal := &types.SessionPrincipal{
		Subject:     "entra-oid-pod-owner",
		Provider:    "entra",
		Kind:        "operator",
		DisplayName: "JDoe@example.com",
	}
	cfg := defaultConfig()
	if _, err := mgr.StartSession("pod-session", cfg, principal); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// A process-level event carrying no session context, exactly the shape
	// system.metrics/extension.coldstart/extension.hook_latency emit today
	// (correlationCtx never stamps "principal_identity"; system.metrics
	// passes a nil ctx outright).
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	col.Event(telemetry.ExtensionColdstart, map[string]any{}, correlationCtx("pod-session", ""))

	var found *telemetry.Event
	for _, e := range col.BufferedEvents() {
		e := e
		if e.Name == telemetry.ExtensionColdstart {
			found = &e
			break
		}
	}
	if found == nil {
		t.Fatal("expected an extension.coldstart event")
	}
	if found.User != "JDoe@example.com" {
		t.Errorf("User = %q, want %q (pod owner's session principal promoted process-wide)", found.User, "JDoe@example.com")
	}
}

// TestStartSessionNilPrincipalLeavesProcessIdentityUntouched pins B-23: an
// unattributed session (no principal, the common local/CLI case) must not
// clear or otherwise disturb whatever process-wide identity is already set
// (e.g. by the engine's own OIDC sign-in on a desktop install).
func TestStartSessionNilPrincipalLeavesProcessIdentityUntouched(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	telemetry.SetUserIdentity("preexisting-operator")
	t.Cleanup(func() { telemetry.SetUserIdentity("") })

	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	mgr.SetHeartbeatInterval(10 * time.Minute)

	cfg := defaultConfig()
	if _, err := mgr.StartSession("unattributed-session", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	col.Event(telemetry.ExtensionColdstart, map[string]any{}, correlationCtx("unattributed-session", ""))

	var found *telemetry.Event
	for _, e := range col.BufferedEvents() {
		e := e
		if e.Name == telemetry.ExtensionColdstart {
			found = &e
			break
		}
	}
	if found == nil {
		t.Fatal("expected an extension.coldstart event")
	}
	if found.User != "preexisting-operator" {
		t.Errorf("User = %q, want %q (unattributed session must not clear the process-wide identity)", found.User, "preexisting-operator")
	}
}
