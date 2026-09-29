package session

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestStartSessionMultiTenantPrincipalSkipsProcessWidePromotion pins the
// multi-tenant guard added to promoteSessionPrincipalProcessWide
// (start_session.go): a principal from a server that has POSITIVELY
// determined more than one person shares this engine (SessionPrincipal.
// MultiTenant true -- server/src/config/current.ts's isSharedTenancy()
// false, an "isolated" Studio Server install) must never overwrite the
// process-wide telemetry identity, because the next person's session would
// silently steal attribution for every other person's process-level events
// (system.metrics, extension.coldstart, extension.hook_latency).
//
// RED on unfixed code: a second session's MultiTenant principal overwrites
// the first session's already-promoted identity, so the process-level event
// carries the second (wrong) person instead of staying empty.
func TestStartSessionMultiTenantPrincipalSkipsProcessWidePromotion(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	telemetry.SetUserIdentity("")
	t.Cleanup(func() { telemetry.SetUserIdentity("") })

	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	mgr.SetHeartbeatInterval(10 * time.Minute)

	principal := &types.SessionPrincipal{
		Subject:     "entra-oid-teammate",
		Provider:    "entra",
		Kind:        "operator",
		DisplayName: "teammate@dciartform.com",
		MultiTenant: true,
	}
	cfg := defaultConfig()
	if _, err := mgr.StartSession("multi-tenant-session", cfg, principal); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	col.Event(telemetry.ExtensionColdstart, map[string]any{}, correlationCtx("multi-tenant-session", ""))

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
	if found.User != "" {
		t.Errorf("User = %q, want empty (multi-tenant principal must not promote process-wide)", found.User)
	}
}

// TestStartSessionMultiTenantPrincipalDoesNotClobberExistingIdentity pins the
// clobbering half of the same defect: a multi-tenant session started AFTER
// a legitimately-promoted single-person identity (e.g. the engine's own
// desktop OIDC sign-in) must not overwrite it either.
//
// RED on unfixed code: the multi-tenant principal overwrites the
// pre-existing identity.
func TestStartSessionMultiTenantPrincipalDoesNotClobberExistingIdentity(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	telemetry.SetUserIdentity("desktop-oidc-owner")
	t.Cleanup(func() { telemetry.SetUserIdentity("") })

	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	mgr.SetHeartbeatInterval(10 * time.Minute)

	principal := &types.SessionPrincipal{
		Subject:     "entra-oid-teammate",
		Provider:    "entra",
		Kind:        "operator",
		DisplayName: "teammate@dciartform.com",
		MultiTenant: true,
	}
	cfg := defaultConfig()
	if _, err := mgr.StartSession("multi-tenant-session-2", cfg, principal); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	col.Event(telemetry.ExtensionColdstart, map[string]any{}, correlationCtx("multi-tenant-session-2", ""))

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
	if found.User != "desktop-oidc-owner" {
		t.Errorf("User = %q, want %q (multi-tenant principal must not clobber an existing process-wide identity)", found.User, "desktop-oidc-owner")
	}
}
