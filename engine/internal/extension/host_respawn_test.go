package extension

import (
	"errors"
	"testing"
	"time"
)

// TestRespawn_NoOpWhenAlive ensures Respawn is a safe no-op on a host that
// is not currently dead. The session manager calls Respawn defensively
// from a goroutine, so it must tolerate races.
func TestRespawn_NoOpWhenAlive(t *testing.T) {
	h := &Host{}
	h.lastExitCode.Store(-1)

	attempt, err := h.Respawn()
	if err != nil {
		t.Fatalf("expected nil error on alive host, got %v", err)
	}
	if attempt != 0 {
		t.Fatalf("expected attempt=0, got %d", attempt)
	}
}

// TestRespawn_BudgetExceeded simulates a host that has been respawned the
// maximum number of times within the rolling window. The next Respawn
// should mark the host permanently dead and return ErrBudgetExceeded.
//
// The test bypasses the actual subprocess spawn by pointing loadedPath at
// a path that exists but isn't a runnable extension — the budget check
// runs before the spawn so we never reach that code path.
func TestRespawn_BudgetExceeded(t *testing.T) {
	h := &Host{}
	h.lastExitCode.Store(-1)
	h.dead.Store(true)
	h.loadedPath = "/usr/bin/true"
	h.loadedConfig = &ExtensionConfig{}

	// Pre-load 3 attempts in the current window — the next Respawn should
	// be the 4th and trip the cap.
	now := time.Now().UnixNano()
	h.respawnWindowStart.Store(now)
	h.respawnAttempts.Store(int64(respawnBudgetMax))

	_, err := h.Respawn()
	if !errors.Is(err, ErrBudgetExceeded) {
		t.Fatalf("expected ErrBudgetExceeded, got %v", err)
	}
	if !h.respawnPermanent.Load() {
		t.Fatal("expected respawnPermanent flag to be set")
	}

	// A subsequent Respawn must still fail without re-running the spawn.
	_, err = h.Respawn()
	if !errors.Is(err, ErrBudgetExceeded) {
		t.Fatalf("expected sticky ErrBudgetExceeded on second call, got %v", err)
	}
}

// TestRespawn_HealthyReset verifies that a host alive for more than the
// healthy-reset duration gets its attempt counter reset on the next death,
// so a long-running extension that crashes once is not permanently capped.
func TestRespawn_HealthyReset(t *testing.T) {
	h := &Host{}
	h.lastExitCode.Store(-1)
	h.dead.Store(true)
	h.loadedPath = "/nonexistent/path/does/not/exist"
	h.loadedConfig = &ExtensionConfig{}

	now := time.Now().UnixNano()
	// Pretend the host has been alive far past the healthy reset window.
	h.lastHealthyAt.Store(now - int64(2*respawnHealthyReset))
	h.respawnWindowStart.Store(now - int64(2*respawnHealthyReset))
	h.respawnAttempts.Store(int64(respawnBudgetMax)) // exhausted in prior window

	// Respawn will fail to actually spawn (bogus path) but the budget
	// reset must happen before the spawn attempt. After the call, the
	// attempt counter should be 1, not 4.
	_, _ = h.Respawn()

	if got := h.respawnAttempts.Load(); got != 1 {
		t.Fatalf("expected attempts to reset to 1 after healthy window, got %d", got)
	}
	if h.respawnPermanent.Load() {
		t.Fatal("did not expect respawnPermanent — budget should have reset")
	}
}

// TestRespawn_NoCachedParamsErrors ensures Respawn fails clearly if it is
// invoked on a host that was never successfully Loaded.
func TestRespawn_NoCachedParamsErrors(t *testing.T) {
	h := &Host{}
	h.lastExitCode.Store(-1)
	h.dead.Store(true)
	// loadedPath intentionally empty.

	_, err := h.Respawn()
	if err == nil {
		t.Fatal("expected error for missing spawn parameters")
	}
}

// TestDead_TracksFlag is a sanity check on the public accessor used by the
// session manager to decide whether a host needs respawning.
func TestDead_TracksFlag(t *testing.T) {
	h := &Host{}
	if h.Dead() {
		t.Fatal("fresh host should not be dead")
	}
	h.dead.Store(true)
	if !h.Dead() {
		t.Fatal("Dead() should reflect dead.Load() = true")
	}
}

// TestMarkTurnInFlight_RoundTrips verifies the manager-side flag plumbing
// that decides whether turn_aborted fires after a respawn.
func TestMarkTurnInFlight_RoundTrips(t *testing.T) {
	h := &Host{}
	if h.TurnInFlightAtDeath() {
		t.Fatal("default should be false")
	}
	h.MarkTurnInFlight(true)
	if !h.TurnInFlightAtDeath() {
		t.Fatal("expected true after MarkTurnInFlight(true)")
	}
	h.MarkTurnInFlight(false)
	if h.TurnInFlightAtDeath() {
		t.Fatal("expected false after MarkTurnInFlight(false)")
	}
}

// TestLastExit_DefaultsToNil ensures LastExit returns nil/empty for a
// fresh host so event payloads don't claim a fake zero exit.
func TestLastExit_DefaultsToNil(t *testing.T) {
	h := &Host{}
	h.lastExitCode.Store(-1)
	code, signal := h.LastExit()
	if code != nil {
		t.Fatalf("expected nil exit code on fresh host, got %d", *code)
	}
	if signal != "" {
		t.Fatalf("expected empty signal on fresh host, got %q", signal)
	}
}
