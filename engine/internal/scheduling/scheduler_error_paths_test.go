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

// TestScheduler_NilContextResolve_SkipsWithoutPanic pins the guard against the
// SessionResolver (nil, nil) contract. A resolver that returns a nil context and
// a nil error must produce a no_session skip, NOT a panic. fireJob runs in its
// own goroutine with no recover, so an unguarded err.Error() on this branch
// crashes the process. This test drives fireJob directly with such a resolver
// and asserts the skip event is emitted (which is only reachable if the branch
// does not panic first).
func TestScheduler_NilContextResolve_SkipsWithoutPanic(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "nil-ctx-job",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 1000,
	}
	h := testHostWithSchedule(t, "ion-dev", job)

	events := make(chan types.EngineEvent, 32)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) { events <- ev })
	s.nowFn = func() time.Time { return time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC) }
	s.AddHost(h)

	// Resolver returns (nil, nil): the exact contract shape that nil-derefs an
	// unguarded err.Error(). fireJob is synchronous here (called directly, not
	// via `go`), so a panic would fail the test rather than crash a detached
	// goroutine.
	nilResolver := func(_ *extension.Host) (*extension.Context, error) { return nil, nil }
	key := hostJobKey{host: h, id: job.JobID}
	s.fireJob(h, job, key, nilResolver)

	collected := drainEvents(events)
	var sawSkipped bool
	for _, ev := range collected {
		if ev.Type == "engine_schedule_skipped" &&
			ev.AsyncID == "nil-ctx-job" &&
			ev.AsyncReason == "no_session" {
			sawSkipped = true
		}
	}
	if !sawSkipped {
		t.Fatalf("expected engine_schedule_skipped/no_session on nil-context resolve, got: %v", eventTypes(collected))
	}
}

// setupWithMetaTest creates a scheduler and host wired for FireScheduleNow-based
// tests of the fireJobWithMeta code path. The host is added to the scheduler so
// the concurrency-target resolution inside FireScheduleNow finds it in s.hosts.
// Returns the scheduler, host, and event channel.
func setupWithMetaTest(t *testing.T, job extension.ScheduleJob) (*Scheduler, *extension.Host, chan types.EngineEvent) {
	t.Helper()
	h := extension.NewHost()
	h.SetNameForTest("ion-dev")
	if err := h.AsyncRegistry().Register(asyncreg.KindSchedule, job, asyncreg.OriginInit, nil); err != nil {
		t.Fatalf("register: %v", err)
	}

	events := make(chan types.EngineEvent, 32)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) { events <- ev })
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "test"}, nil
	})

	s.nowFn = func() time.Time { return time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC) }
	s.AddHost(h)
	return s, h, events
}

// TestScheduler_WithMeta_PredicateError_EmitsSkippedEvent exercises the
// fireJobWithMeta code path via FireScheduleNow. fireJobWithMeta is only
// reachable through FireScheduleNow — the tick loop always routes through
// maybeFire → fireJob. Ensures the predicate-error branch of fireJobWithMeta
// emits engine_schedule_skipped/predicate_error.
func TestScheduler_WithMeta_PredicateError_EmitsSkippedEvent(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:          "with-meta-pred-error",
		Kind:           extension.ScheduleInterval,
		IntervalMs:     1000,
		EnabledRefName: "schedule:with-meta-pred-error:enabled",
	}

	s, h, events := setupWithMetaTest(t, job)

	predicateErr := errors.New("predicate RPC failed")
	s.SetResolveEnabledFnForTest(func(_ *extension.Host, _ extension.ScheduleJob) (bool, error) {
		return false, predicateErr
	})

	if err := s.FireScheduleNow(h, job.JobID); err != nil {
		t.Fatalf("FireScheduleNow: %v", err)
	}
	time.Sleep(300 * time.Millisecond)

	collected := drainEvents(events)

	var sawSkipped bool
	for _, ev := range collected {
		if ev.Type == "engine_schedule_skipped" &&
			ev.AsyncID == "with-meta-pred-error" &&
			ev.AsyncReason == "predicate_error" {
			sawSkipped = true
		}
		// Must NOT emit engine_schedule_failed — predicate errors are skips.
		if ev.Type == "engine_schedule_failed" && ev.AsyncID == "with-meta-pred-error" {
			t.Errorf("predicate error must emit skipped, not failed: %+v", ev)
		}
	}
	if !sawSkipped {
		t.Fatalf("fireJobWithMeta predicate error: expected engine_schedule_skipped/predicate_error, got: %v", eventTypes(collected))
	}
}

// TestScheduler_WithMeta_HandlerError_EmitsFailedEvent exercises the handler-error
// branch of fireJobWithMeta via FireScheduleNow. When FireAsync returns an error
// (no subprocess wired — expected in unit tests), fireJobWithMeta must emit
// engine_schedule_failed. This is the second LevelError line in fireJobWithMeta
// (line 596 of scheduler.go) that had no test coverage through the actual code path.
func TestScheduler_WithMeta_HandlerError_EmitsFailedEvent(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "with-meta-handler-error",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 1000,
		// No EnabledRefName — execution proceeds directly to FireAsync, which
		// fails because the host has no subprocess wired.
	}

	s, h, events := setupWithMetaTest(t, job)

	if err := s.FireScheduleNow(h, job.JobID); err != nil {
		t.Fatalf("FireScheduleNow: %v", err)
	}
	time.Sleep(300 * time.Millisecond)

	collected := drainEvents(events)

	var sawFailed bool
	for _, ev := range collected {
		if ev.Type == "engine_schedule_failed" && ev.AsyncID == "with-meta-handler-error" {
			sawFailed = true
		}
	}
	if !sawFailed {
		t.Fatalf("fireJobWithMeta handler error: expected engine_schedule_failed, got: %v", eventTypes(collected))
	}
}
