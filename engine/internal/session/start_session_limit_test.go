package session

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// Tests for D-007: enterprise session cap enforced at StartSession.
//
// The merged config's ResourceLimits.MaxSessions (already sealed by
// EnforceEnterprise) caps concurrent session creation. Re-asserting an
// existing session key stays idempotent and never counts against the limit.

func managerWithSessionLimit(limit int) *Manager {
	mgr := NewManager(backend.NewApiBackend())
	mgr.SetConfig(&types.EngineRuntimeConfig{
		ResourceLimits: &types.ResourceLimits{MaxSessions: &limit},
	})
	return mgr
}

func TestStartSession_LimitReached_Rejects(t *testing.T) {
	mgr := managerWithSessionLimit(2)
	defer mgr.Shutdown()

	// Fill the two allowed slots.
	if _, err := mgr.StartSession("s1", types.EngineConfig{}); err != nil {
		t.Fatalf("first session should start: %v", err)
	}
	if _, err := mgr.StartSession("s2", types.EngineConfig{}); err != nil {
		t.Fatalf("second session should start: %v", err)
	}

	// Third distinct session must be rejected.
	_, err := mgr.StartSession("s3", types.EngineConfig{})
	if err == nil {
		t.Fatal("third session must be rejected at MaxSessions=2")
	}
	if !strings.Contains(err.Error(), "session limit reached") {
		t.Errorf("error must carry the stable 'session limit reached' prefix, got %q", err.Error())
	}
}

func TestStartSession_LimitReached_ExistingKeyStaysIdempotent(t *testing.T) {
	mgr := managerWithSessionLimit(1)
	defer mgr.Shutdown()

	if _, err := mgr.StartSession("s1", types.EngineConfig{}); err != nil {
		t.Fatalf("first session should start: %v", err)
	}

	// Re-asserting the SAME key at the cap must succeed (idempotent path,
	// not new creation) — the desktop's restart-restore flow depends on it.
	result, err := mgr.StartSession("s1", types.EngineConfig{})
	if err != nil {
		t.Fatalf("re-asserting an existing session must not trip the limit: %v", err)
	}
	if !result.Existed {
		t.Error("re-assertion should report Existed=true")
	}
}

func TestStartSession_UnderLimit_Succeeds(t *testing.T) {
	mgr := managerWithSessionLimit(2)
	defer mgr.Shutdown()

	if _, err := mgr.StartSession("s1", types.EngineConfig{}); err != nil {
		t.Fatalf("session under the limit should start: %v", err)
	}
}

func TestStartSession_NoLimit_Unbounded(t *testing.T) {
	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()
	mgr.SetConfig(&types.EngineRuntimeConfig{}) // no ResourceLimits

	for _, key := range []string{"a", "b", "c", "d", "e"} {
		if _, err := mgr.StartSession(key, types.EngineConfig{}); err != nil {
			t.Fatalf("without ResourceLimits every session should start, %q failed: %v", key, err)
		}
	}
}

func TestStartSession_SlotFreedAfterStop(t *testing.T) {
	mgr := managerWithSessionLimit(1)
	defer mgr.Shutdown()

	if _, err := mgr.StartSession("s1", types.EngineConfig{}); err != nil {
		t.Fatalf("first session should start: %v", err)
	}
	if _, err := mgr.StartSession("s2", types.EngineConfig{}); err == nil {
		t.Fatal("second session must be rejected at MaxSessions=1")
	}

	// Stopping the first session frees the slot.
	if err := mgr.StopSession("s1"); err != nil {
		t.Fatalf("stop failed: %v", err)
	}
	if _, err := mgr.StartSession("s2", types.EngineConfig{}); err != nil {
		t.Fatalf("session should start after a slot was freed: %v", err)
	}
}
