// Tests for the error-path event emissions on the scheduler's predicate-failure
// and handler-error branches. These paths emit engine_schedule_skipped
// (reason=predicate_error) and engine_schedule_failed respectively. The log
// level of these branches was raised to ERROR by issue #276; the observable
// contract — the typed events — is pinned here so a regression that silences
// either path turns these tests red.

package scheduling

import (
	"errors"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// setupErrorPathTest creates a scheduler wired with a controllable clock, a
// session resolver that always succeeds, and a buffered event channel. The job
// is bootstrapped with a first tick before returning so the second tick fires.
func setupErrorPathTest(t *testing.T, job extension.ScheduleJob) (*Scheduler, chan types.EngineEvent) {
	t.Helper()
	h := testHostWithSchedule(t, "ion-dev", job)

	events := make(chan types.EngineEvent, 32)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) { events <- ev })
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "test"}, nil
	})

	baseTime := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	s.nowFn = func() time.Time { return baseTime }
	s.AddHost(h)
	s.tickOnce() // bootstrap nextRun

	// Advance so the job is due on the next tick.
	due := baseTime.Add(2 * time.Second)
	s.nowFn = func() time.Time { return due }

	return s, events
}

// TestScheduler_PredicateError_EmitsSkippedEvent verifies that when the
// enabled-predicate RPC returns an error the scheduler emits
// engine_schedule_skipped with reason=predicate_error. This is the error path
// that was previously logged at INFO (issue #276); the event emission is the
// observable guarantee that does not depend on log level.
func TestScheduler_PredicateError_EmitsSkippedEvent(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:          "pred-error-job",
		Kind:           extension.ScheduleInterval,
		IntervalMs:     1000,
		EnabledRefName: "schedule:pred-error-job:enabled",
	}

	s, events := setupErrorPathTest(t, job)

	// Inject a predicate that always errors.
	predicateErr := errors.New("RPC timeout")
	s.SetResolveEnabledFnForTest(func(_ *extension.Host, _ extension.ScheduleJob) (bool, error) {
		return false, predicateErr
	})

	s.tickOnce()
	time.Sleep(300 * time.Millisecond)

	collected := drainEvents(events)

	var sawSkipped bool
	for _, ev := range collected {
		if ev.Type == "engine_schedule_skipped" &&
			ev.AsyncID == "pred-error-job" &&
			ev.AsyncReason == "predicate_error" {
			sawSkipped = true
		}
		// Must NOT emit engine_schedule_failed — predicate errors are skips.
		if ev.Type == "engine_schedule_failed" && ev.AsyncID == "pred-error-job" {
			t.Errorf("predicate error must emit skipped, not failed: %+v", ev)
		}
	}
	if !sawSkipped {
		t.Fatalf("expected engine_schedule_skipped/predicate_error, got: %v", eventTypes(collected))
	}
}

// TestScheduler_HandlerError_EmitsFailedEvent verifies that when FireAsync
// returns an error (subprocess failure, timeout, transport fault) the scheduler
// emits engine_schedule_failed. This is the handler-error path that was
// previously logged at INFO (issue #276).
func TestScheduler_HandlerError_EmitsFailedEvent(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "handler-error-job",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 1000,
	}

	s, events := setupErrorPathTest(t, job)
	// No predicate — FireAsync will fail because the host has no subprocess.

	s.tickOnce()
	time.Sleep(300 * time.Millisecond)

	collected := drainEvents(events)

	var sawFailed bool
	for _, ev := range collected {
		if ev.Type == "engine_schedule_failed" && ev.AsyncID == "handler-error-job" {
			sawFailed = true
		}
	}
	if !sawFailed {
		t.Fatalf("expected engine_schedule_failed for handler error, got: %v", eventTypes(collected))
	}
}

// TestScheduler_WithMeta_PredicateError_EmitsSkippedEvent exercises the
// fireJobWithMeta code path (used when the session resolver returns a context).
// Ensures predicate_error skips emit the correct event from that path too.
func TestScheduler_WithMeta_PredicateError_EmitsSkippedEvent(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:          "with-meta-pred-error",
		Kind:           extension.ScheduleInterval,
		IntervalMs:     1000,
		EnabledRefName: "schedule:with-meta-pred-error:enabled",
	}

	// Use the asyncreg metadata path: register a handler ref so fireJobWithMeta
	// is invoked. The meta path fires when the asyncreg entry has a non-empty
	// handler registered — in tests without a subprocess the direct FireAsync
	// call will fail, but we only need the predicate branch.
	h := extension.NewHost()
	h.SetNameForTest("ion-dev")
	err := h.AsyncRegistry().Register(asyncreg.KindSchedule, job, asyncreg.OriginInit, nil)
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	events := make(chan types.EngineEvent, 32)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) { events <- ev })
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "test"}, nil
	})
	predicateErr := errors.New("predicate RPC failed")
	s.SetResolveEnabledFnForTest(func(_ *extension.Host, _ extension.ScheduleJob) (bool, error) {
		return false, predicateErr
	})

	baseTime := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	s.nowFn = func() time.Time { return baseTime }
	s.AddHost(h)
	s.tickOnce()

	due := baseTime.Add(2 * time.Second)
	s.nowFn = func() time.Time { return due }
	s.tickOnce()
	time.Sleep(300 * time.Millisecond)

	collected := drainEvents(events)

	var sawSkipped bool
	for _, ev := range collected {
		if ev.Type == "engine_schedule_skipped" &&
			ev.AsyncID == "with-meta-pred-error" &&
			ev.AsyncReason == "predicate_error" {
			sawSkipped = true
		}
	}
	if !sawSkipped {
		t.Fatalf("fireJobWithMeta predicate error: expected engine_schedule_skipped/predicate_error, got: %v", eventTypes(collected))
	}
}
