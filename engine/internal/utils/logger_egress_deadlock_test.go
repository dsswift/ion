package utils

// logger_egress_deadlock_test.go — regression for the ConfigureLogging deadlock.
//
// newEgressForwarder emits a log line on the EgressManagedByClient path (the
// desktop-launched engine). If it is constructed while ConfigureLogging holds
// logMu, that log line re-acquires the non-reentrant logMu and self-deadlocks,
// hanging the engine at boot (every desktop-launched engine). The fix builds the
// forwarder BEFORE taking logMu. This test pins that ConfigureLogging always
// returns; on the unfixed code the goroutine never completes and the test fails
// on the timeout instead of hanging the whole binary.

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestConfigureLoggingEgressManagedByClientDoesNotDeadlock(t *testing.T) {
	// A managing client delegates egress: targets are configured but the engine
	// must suppress its own forwarder (and log that it did). This is the exact
	// shape the desktop passes and the one that triggered the boot deadlock.
	cfg := &types.LoggingConfig{
		EgressTargets:         []string{"http"},
		EgressEndpoint:        "https://example.invalid/ingest",
		EgressManagedByClient: true,
	}

	done := make(chan struct{})
	go func() {
		ConfigureLogging(cfg)
		close(done)
	}()

	select {
	case <-done:
		// Completed — no deadlock.
	case <-time.After(5 * time.Second):
		t.Fatal("ConfigureLogging deadlocked: newEgressForwarder logged the suppression notice while logMu was held, re-acquiring the non-reentrant mutex")
	}

	// The delegated path must NOT install an engine-owned forwarder.
	logMu.Lock()
	fwd := activeEgressForwarder
	logMu.Unlock()
	if fwd != nil {
		t.Fatalf("expected no engine forwarder when EgressManagedByClient=true, got %p", fwd)
	}
}
