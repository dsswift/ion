package scheduling

import (
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestParseHHMM(t *testing.T) {
	h, m, ok := parseHHMM("09:30")
	if !ok || h != 9 || m != 30 {
		t.Fatalf("got h=%d m=%d ok=%v", h, m, ok)
	}
	if _, _, ok := parseHHMM("9:30"); ok {
		t.Fatal("4-char string should reject")
	}
	if _, _, ok := parseHHMM("24:00"); ok {
		t.Fatal("hour >23 should reject")
	}
	if _, _, ok := parseHHMM("23:60"); ok {
		t.Fatal("minute >59 should reject")
	}
}

func TestWeekdayFromName(t *testing.T) {
	if weekdayFromName("monday") != time.Monday {
		t.Fatal("monday")
	}
	if weekdayFromName("FRIDAY") != time.Friday {
		t.Fatal("uppercase friday")
	}
}

func TestNextRunFor_Interval(t *testing.T) {
	job := extension.ScheduleJob{Kind: extension.ScheduleInterval, IntervalMs: 60_000}
	from := time.Date(2026, 5, 25, 10, 0, 0, 0, time.UTC)
	got := nextRunFor(job, from, time.UTC)
	want := from.Add(time.Minute)
	if !got.Equal(want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestNextRunFor_DailyForward(t *testing.T) {
	// 09:30 UTC daily. Asked from 08:00 same day → should fire today at 09:30.
	job := extension.ScheduleJob{Kind: extension.ScheduleDaily, Time: "09:30"}
	from := time.Date(2026, 5, 25, 8, 0, 0, 0, time.UTC)
	got := nextRunFor(job, from, time.UTC)
	want := time.Date(2026, 5, 25, 9, 30, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestNextRunFor_DailyWraps(t *testing.T) {
	// 09:30 UTC daily. Asked from 10:00 same day → should fire tomorrow at 09:30.
	job := extension.ScheduleJob{Kind: extension.ScheduleDaily, Time: "09:30"}
	from := time.Date(2026, 5, 25, 10, 0, 0, 0, time.UTC)
	got := nextRunFor(job, from, time.UTC)
	want := time.Date(2026, 5, 26, 9, 30, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestNextRunFor_WeeklyForward(t *testing.T) {
	// 09:30 Monday. Asked from a Wednesday → next Monday.
	job := extension.ScheduleJob{Kind: extension.ScheduleWeekly, Time: "09:30", DayOfWeek: "monday"}
	// 2026-05-25 is a Monday.
	from := time.Date(2026, 5, 27, 10, 0, 0, 0, time.UTC) // Wed
	got := nextRunFor(job, from, time.UTC)
	if got.Weekday() != time.Monday {
		t.Fatalf("got weekday %v want Monday", got.Weekday())
	}
	if got.Hour() != 9 || got.Minute() != 30 {
		t.Fatalf("got time %v want 09:30", got)
	}
	// The next Monday after 2026-05-27 is 2026-06-01.
	want := time.Date(2026, 6, 1, 9, 30, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestNextRunFor_WeeklyTodayAlreadyPassed(t *testing.T) {
	// Monday 09:30, asked from Monday 11:00 → next Monday.
	job := extension.ScheduleJob{Kind: extension.ScheduleWeekly, Time: "09:30", DayOfWeek: "monday"}
	from := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC) // Mon 11:00
	got := nextRunFor(job, from, time.UTC)
	want := time.Date(2026, 6, 1, 9, 30, 0, 0, time.UTC) // next Monday
	if !got.Equal(want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestLastScheduledSlotBefore_Daily(t *testing.T) {
	job := extension.ScheduleJob{Kind: extension.ScheduleDaily, Time: "09:30"}
	// at 11:00 today, last slot is today at 09:30
	t11 := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC)
	got := lastScheduledSlotBefore(job, t11, time.UTC)
	want := time.Date(2026, 5, 25, 9, 30, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	// at 08:00 today, last slot is yesterday at 09:30
	t8 := time.Date(2026, 5, 25, 8, 0, 0, 0, time.UTC)
	got = lastScheduledSlotBefore(job, t8, time.UTC)
	want = time.Date(2026, 5, 24, 9, 30, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestSchedulerStartStop(t *testing.T) {
	s := New(Config{})
	s.Start()
	// Idempotent
	s.Start()
	// Tick once manually to be sure it does not panic with no hosts.
	s.tickOnce()
	s.Stop()
	// Idempotent stop
	s.Stop()
}

// TestPersistence_FullCoverage_SeeOtherFile is a marker pointing
// readers at persistence_test.go for the on-disk round-trip,
// sanitisation, and bad-file behaviors. Kept here so a search for
// "persist" in this file finds the cross-reference.
func TestPersistence_FullCoverage_SeeOtherFile(t *testing.T) {
	t.Skip("see persistence_test.go for full coverage")
}

func TestSafeName(t *testing.T) {
	if safeName("hello/world") != "hello_world" {
		t.Fatal("slash should sanitize")
	}
	if safeName("") != "unnamed" {
		t.Fatal("empty should become unnamed")
	}
	if safeName("abc-123_def.foo") != "abc-123_def.foo" {
		t.Fatal("alnum + - _ . should pass")
	}
}

// ─── Concurrency coordination tests ───

// testHostWithSchedule creates a Host with a name and schedule jobs
// registered in its asyncreg registry. No subprocess is loaded.
func testHostWithSchedule(t *testing.T, name string, jobs ...extension.ScheduleJob) *extension.Host {
	t.Helper()
	h := extension.NewHost()
	h.SetNameForTest(name)
	for _, job := range jobs {
		err := h.AsyncRegistry().Register(asyncreg.KindSchedule, job, asyncreg.OriginInit, nil)
		if err != nil {
			t.Fatalf("register job %q: %v", job.JobID, err)
		}
	}
	return h
}

// fireTracker records which host names enter the fire path via the
// session resolver.
type fireTracker struct {
	mu    sync.Mutex
	fired []string
}

func (ft *fireTracker) resolver() SessionResolver {
	return func(host *extension.Host) (*extension.Context, error) {
		ft.mu.Lock()
		ft.fired = append(ft.fired, host.Name())
		ft.mu.Unlock()
		return &extension.Context{SessionKey: "test-" + host.Name()}, nil
	}
}

func (ft *fireTracker) count() int {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	return len(ft.fired)
}

func (ft *fireTracker) countByName(name string) int {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	n := 0
	for _, f := range ft.fired {
		if f == name {
			n++
		}
	}
	return n
}

// setupConcurrencyTest creates a scheduler with a controllable clock,
// adds the given hosts, bootstraps nextRun on the first tick, advances
// time past the interval, and returns the scheduler + tracker ready
// for the second tick.
func setupConcurrencyTest(t *testing.T, hosts ...*extension.Host) (*Scheduler, *fireTracker) {
	t.Helper()
	tracker := &fireTracker{}
	s := New(Config{})
	s.SetSessionResolver(tracker.resolver())
	s.SetEmit(func(ev types.EngineEvent) {})

	baseTime := time.Date(2026, 6, 6, 10, 0, 0, 0, time.UTC)
	s.nowFn = func() time.Time { return baseTime }

	for _, h := range hosts {
		s.AddHost(h)
	}

	// First tick: bootstraps nextRun for all jobs
	s.tickOnce()

	// Advance time past the interval so jobs are due
	s.nowFn = func() time.Time { return baseTime.Add(2 * time.Second) }

	return s, tracker
}

func TestScheduler_Concurrency_SingleDefault(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "morning-brief",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 1000,
		// Concurrency defaults to "" which means single
	}

	h1 := testHostWithSchedule(t, "ion-dev", job)
	h2 := testHostWithSchedule(t, "ion-dev", job)
	h3 := testHostWithSchedule(t, "ion-dev", job)

	s, tracker := setupConcurrencyTest(t, h1, h2, h3)

	// Second tick: fires with concurrency coordination
	s.tickOnce()

	// Wait for fire goroutines (they fail quickly — no subprocess)
	time.Sleep(200 * time.Millisecond)

	if got := tracker.count(); got != 1 {
		t.Fatalf("single mode: expected 1 fire, got %d: %v", got, tracker.fired)
	}
}

func TestScheduler_Concurrency_All(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:       "morning-brief",
		Kind:        extension.ScheduleInterval,
		IntervalMs:  1000,
		Concurrency: "all",
	}

	h1 := testHostWithSchedule(t, "ion-dev", job)
	h2 := testHostWithSchedule(t, "ion-dev", job)
	h3 := testHostWithSchedule(t, "ion-dev", job)

	s, tracker := setupConcurrencyTest(t, h1, h2, h3)

	s.tickOnce()
	time.Sleep(200 * time.Millisecond)

	if got := tracker.count(); got != 3 {
		t.Fatalf("all mode: expected 3 fires, got %d: %v", got, tracker.fired)
	}
}

func TestScheduler_Concurrency_CrossExtension(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "morning-brief",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 1000,
		// single mode (default)
	}

	// Two ion-dev hosts + two chief-of-staff hosts
	id1 := testHostWithSchedule(t, "ion-dev", job)
	id2 := testHostWithSchedule(t, "ion-dev", job)
	cs1 := testHostWithSchedule(t, "chief-of-staff", job)
	cs2 := testHostWithSchedule(t, "chief-of-staff", job)

	s, tracker := setupConcurrencyTest(t, id1, id2, cs1, cs2)

	s.tickOnce()
	time.Sleep(200 * time.Millisecond)

	idCount := tracker.countByName("ion-dev")
	csCount := tracker.countByName("chief-of-staff")

	if idCount != 1 {
		t.Errorf("ion-dev: expected 1 fire, got %d", idCount)
	}
	if csCount != 1 {
		t.Errorf("chief-of-staff: expected 1 fire, got %d", csCount)
	}
	if got := tracker.count(); got != 2 {
		t.Errorf("total: expected 2 fires, got %d: %v", got, tracker.fired)
	}
}

func TestScheduler_Concurrency_DeadHostSkipped(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "morning-brief",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 1000,
	}

	h1 := testHostWithSchedule(t, "ion-dev", job)
	h2 := testHostWithSchedule(t, "ion-dev", job)
	h3 := testHostWithSchedule(t, "ion-dev", job)

	// Kill the first host
	h1.MarkDeadForTest()

	s, tracker := setupConcurrencyTest(t, h1, h2, h3)

	s.tickOnce()
	time.Sleep(200 * time.Millisecond)

	if got := tracker.count(); got != 1 {
		t.Fatalf("dead-host skip: expected 1 fire, got %d: %v", got, tracker.fired)
	}
}

func TestScheduleJob_Validate_Concurrency(t *testing.T) {
	base := extension.ScheduleJob{
		JobID:      "test",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 1000,
	}

	for _, c := range []string{"", "single", "all"} {
		j := base
		j.Concurrency = c
		if err := j.Validate(); err != nil {
			t.Errorf("concurrency=%q should be valid, got: %v", c, err)
		}
	}

	j := base
	j.Concurrency = "invalid"
	if err := j.Validate(); err == nil {
		t.Error("concurrency='invalid' should fail validation")
	}
}

// ─── Once schedule tests ───

// TestNextRunFor_Once checks that nextRunFor returns from+delayMs for
// a once job.
func TestNextRunFor_Once(t *testing.T) {
	job := extension.ScheduleJob{
		Kind:    extension.ScheduleOnce,
		DelayMs: 5000,
	}
	from := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	got := nextRunFor(job, from, time.UTC)
	want := from.Add(5 * time.Second)
	if !got.Equal(want) {
		t.Fatalf("nextRunFor once: got %v want %v", got, want)
	}
}

// TestScheduleJob_Validate_Once checks Validate for once jobs.
func TestScheduleJob_Validate_Once(t *testing.T) {
	// Too small delayMs — must be rejected.
	bad := extension.ScheduleJob{JobID: "x", Kind: extension.ScheduleOnce, DelayMs: 500}
	if err := bad.Validate(); err == nil {
		t.Fatal("once with delayMs=500 should fail validate")
	}
	// Exactly 1000 — accepted.
	ok := extension.ScheduleJob{JobID: "x", Kind: extension.ScheduleOnce, DelayMs: 1000}
	if err := ok.Validate(); err != nil {
		t.Fatalf("once with delayMs=1000 should be valid, got: %v", err)
	}
	// Zero delayMs — rejected.
	zero := extension.ScheduleJob{JobID: "x", Kind: extension.ScheduleOnce, DelayMs: 0}
	if err := zero.Validate(); err == nil {
		t.Fatal("once with delayMs=0 should fail validate")
	}
	// Unknown kind — rejected.
	unknown := extension.ScheduleJob{JobID: "x", Kind: extension.ScheduleKind("bogus")}
	if err := unknown.Validate(); err == nil {
		t.Fatal("unknown kind should fail validate")
	}
}

// setupOnceTest creates a scheduler with a controllable clock and a
// once job already bootstrapped (first tick), then advances time past
// the delay so the job is due. Returns (scheduler, host, eventChan).
func setupOnceTest(t *testing.T, delayMs int64) (*Scheduler, *extension.Host, chan types.EngineEvent) {
	t.Helper()
	job := extension.ScheduleJob{
		JobID:   "one-shot",
		Kind:    extension.ScheduleOnce,
		DelayMs: delayMs,
	}
	h := testHostWithSchedule(t, "ion-dev", job)

	events := make(chan types.EngineEvent, 32)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) { events <- ev })
	// Resolver returns a valid context — FireAsync will fail (no subprocess)
	// but that is expected in unit tests; the once deregister still fires.
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "test"}, nil
	})

	baseTime := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	s.nowFn = func() time.Time { return baseTime }
	s.AddHost(h)

	// First tick: bootstrap nextRun (job is registered, delay not elapsed).
	s.tickOnce()

	// Advance time past the delay so the job is due.
	due := baseTime.Add(time.Duration(delayMs) * time.Millisecond).Add(time.Second)
	s.nowFn = func() time.Time { return due }

	return s, h, events
}

// TestScheduleOnce_FiresExactlyOnce verifies that a once job fires on
// the first due tick and does not fire again after another delay
// period elapses.
func TestScheduleOnce_FiresExactlyOnce(t *testing.T) {
	s, h, events := setupOnceTest(t, 2000)

	// Second tick: job is due, handler fires (fails — no subprocess).
	s.tickOnce()
	time.Sleep(300 * time.Millisecond) // let the goroutine complete

	// Collect events.
	collected := drainEvents(events)

	// Must see engine_schedule_deregistered with reason=once_complete.
	var sawDeregister bool
	for _, ev := range collected {
		if ev.Type == "engine_schedule_deregistered" && ev.AsyncID == "one-shot" && ev.AsyncReason == "once_complete" {
			sawDeregister = true
		}
	}
	if !sawDeregister {
		t.Fatalf("expected engine_schedule_deregistered/once_complete, got: %v", eventTypes(collected))
	}

	// After deregister, a subsequent tick must not fire again.
	firesBefore := countFires(events)
	_ = firesBefore

	// Drain the channel to get a clean baseline.
	drainEvents(events)

	// Advance time well past another delay period.
	s.mu.Lock()
	s.nowFn = func() time.Time {
		return time.Date(2026, 6, 1, 10, 1, 0, 0, time.UTC)
	}
	s.mu.Unlock()

	s.tickOnce()
	time.Sleep(300 * time.Millisecond)

	// No further schedule_fired, schedule_failed, or deregistered events.
	secondRound := drainEvents(events)
	for _, ev := range secondRound {
		if ev.AsyncID == "one-shot" {
			t.Errorf("unexpected event after once deregister: %+v", ev)
		}
	}

	// Job must be absent from host registry.
	schedules := h.Schedules()
	for _, j := range schedules {
		if j.JobID == "one-shot" {
			t.Errorf("once job still present in host registry after fire")
		}
	}
}

// TestScheduleOnce_AbsentFromNextRunAfterFire verifies that after the
// once job fires, its key is removed from the scheduler's nextRun map.
func TestScheduleOnce_AbsentFromNextRunAfterFire(t *testing.T) {
	s, _, _ := setupOnceTest(t, 2000)

	s.tickOnce()
	time.Sleep(300 * time.Millisecond)

	s.mu.RLock()
	defer s.mu.RUnlock()
	for k := range s.nextRun {
		if k.id == "one-shot" {
			t.Errorf("once job key still in nextRun after fire")
		}
	}
}

// TestScheduleOnce_SkippedPredicate_RemainsArmed verifies that when a
// once job's enabled predicate returns false (disabled), the job is
// skipped (engine_schedule_skipped/disabled) but NOT deregistered. A
// later tick when the predicate returns true fires the handler and
// then deregisters.
func TestScheduleOnce_SkippedPredicate_RemainsArmed(t *testing.T) {
	predicateEnabled := false

	job := extension.ScheduleJob{
		JobID:          "one-shot-pred",
		Kind:           extension.ScheduleOnce,
		DelayMs:        2000,
		EnabledRefName: "schedule:one-shot-pred:enabled",
	}
	h := testHostWithSchedule(t, "ion-dev", job)

	events := make(chan types.EngineEvent, 32)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) { events <- ev })
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "test"}, nil
	})
	// Inject a test predicate that reads our local bool.
	s.SetResolveEnabledFnForTest(func(_ *extension.Host, _ extension.ScheduleJob) (bool, error) {
		return predicateEnabled, nil
	})

	baseTime := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	dueTime := baseTime.Add(3 * time.Second)
	s.nowFn = func() time.Time { return baseTime }
	s.AddHost(h)
	s.tickOnce() // bootstrap

	s.nowFn = func() time.Time { return dueTime }

	// Tick 1 with predicate=false → skip, NOT deregister.
	s.tickOnce()
	time.Sleep(300 * time.Millisecond)

	ev1 := drainEvents(events)
	var sawSkip bool
	for _, ev := range ev1 {
		if ev.Type == "engine_schedule_skipped" && ev.AsyncID == "one-shot-pred" && ev.AsyncReason == "disabled" {
			sawSkip = true
		}
		if ev.Type == "engine_schedule_deregistered" && ev.AsyncID == "one-shot-pred" {
			t.Errorf("once job deregistered on predicate skip — should stay armed")
		}
	}
	if !sawSkip {
		t.Fatalf("expected engine_schedule_skipped/disabled, got: %v", eventTypes(ev1))
	}

	// Job must still be in host registry.
	found := false
	for _, j := range h.Schedules() {
		if j.JobID == "one-shot-pred" {
			found = true
		}
	}
	if !found {
		t.Fatal("once job removed from registry after predicate skip — should still be armed")
	}

	// Key must still be in nextRun.
	s.mu.RLock()
	_, hasKey := s.nextRun[hostJobKey{host: h, id: "one-shot-pred"}]
	s.mu.RUnlock()
	if !hasKey {
		t.Fatal("nextRun key removed after predicate skip — should stay for retry")
	}

	// Tick 2 with predicate=true → handler fires (fails — no subprocess),
	// then deregisters.
	predicateEnabled = true
	s.tickOnce()
	time.Sleep(300 * time.Millisecond)

	ev2 := drainEvents(events)
	var sawDeregister bool
	for _, ev := range ev2 {
		if ev.Type == "engine_schedule_deregistered" && ev.AsyncID == "one-shot-pred" && ev.AsyncReason == "once_complete" {
			sawDeregister = true
		}
	}
	if !sawDeregister {
		t.Fatalf("expected engine_schedule_deregistered/once_complete after predicate=true tick, got: %v", eventTypes(ev2))
	}
}

// drainEvents collects all events currently queued in the channel
// without blocking.
func drainEvents(ch chan types.EngineEvent) []types.EngineEvent {
	var out []types.EngineEvent
	for {
		select {
		case ev := <-ch:
			out = append(out, ev)
		default:
			return out
		}
	}
}

func countFires(ch chan types.EngineEvent) int {
	n := 0
	for {
		select {
		case ev := <-ch:
			if ev.Type == "engine_schedule_fired" || ev.Type == "engine_schedule_failed" {
				n++
			}
		default:
			return n
		}
	}
}

func eventTypes(evs []types.EngineEvent) []string {
	out := make([]string, len(evs))
	for i, ev := range evs {
		out[i] = ev.Type + "/" + ev.AsyncReason
	}
	return out
}

// TestOrphanedNextRunPruned verifies that when a job is removed from
// the host registry (e.g. via schedule.cancel), the scheduler's
// nextRun entry is pruned on the next tick so a re-registered job
// with the same ID gets a fresh next-run instead of firing on the
// stale value.
func TestOrphanedNextRunPruned(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:   "checkin",
		Kind:    extension.ScheduleOnce,
		DelayMs: 600_000,
	}
	h := testHostWithSchedule(t, "ion-dev", job)

	s := New(Config{})
	s.SetEmit(func(_ types.EngineEvent) {})
	s.SetSessionResolver(func(_ *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "test"}, nil
	})

	baseTime := time.Date(2026, 7, 5, 10, 0, 0, 0, time.UTC)
	s.nowFn = func() time.Time { return baseTime }
	s.AddHost(h)

	// First tick: bootstrap nextRun.
	s.tickOnce()

	// Verify nextRun was set.
	key := hostJobKey{host: h, id: "checkin"}
	s.mu.RLock()
	_, computed := s.nextRun[key]
	s.mu.RUnlock()
	if !computed {
		t.Fatal("nextRun should be computed after first tick")
	}

	// Cancel the job (remove from registry).
	h.DeregisterScheduleDeclSilent("checkin")

	// Next tick: orphaned nextRun should be pruned.
	s.tickOnce()

	s.mu.RLock()
	_, stillThere := s.nextRun[key]
	s.mu.RUnlock()
	if stillThere {
		t.Fatal("orphaned nextRun entry should have been pruned")
	}

	// Re-register with the same ID. Advance time past the original
	// next-run so a stale entry would fire immediately.
	laterTime := baseTime.Add(700 * time.Second)
	s.nowFn = func() time.Time { return laterTime }

	reJob := extension.ScheduleJob{
		JobID:   "checkin",
		Kind:    extension.ScheduleOnce,
		DelayMs: 600_000,
	}
	_ = h.AsyncRegistry().Register(asyncreg.KindSchedule, reJob, asyncreg.OriginInit, nil)

	// Tick: should bootstrap a fresh nextRun at laterTime + 600s.
	s.tickOnce()

	s.mu.RLock()
	next, ok := s.nextRun[key]
	s.mu.RUnlock()
	if !ok {
		t.Fatal("re-registered job should have a nextRun")
	}
	expectedNext := laterTime.Add(600 * time.Second)
	if next.Before(expectedNext) {
		t.Errorf("re-registered job got stale nextRun: %v, expected at or after %v", next, expectedNext)
	}
}

// TestOnceDeregisterSilent verifies that the once-job deregister in
// fireJob uses the silent path (no subprocess callback) so it cannot
// block on an unresponsive readLoop.
func TestOnceDeregisterSilent(t *testing.T) {
	s, h, events := setupOnceTest(t, 2000)

	// Fire the once job.
	s.tickOnce()
	time.Sleep(300 * time.Millisecond)

	collected := drainEvents(events)

	// The job should be deregistered from the registry.
	for _, j := range h.Schedules() {
		if j.JobID == "one-shot" {
			t.Error("once job still in registry after fire")
		}
	}

	// engine_schedule_deregistered event should still be emitted
	// (the scheduler emits it directly, not via the lifecycle hook).
	var sawDeregister bool
	for _, ev := range collected {
		if ev.Type == "engine_schedule_deregistered" && ev.AsyncReason == "once_complete" {
			sawDeregister = true
		}
	}
	if !sawDeregister {
		t.Errorf("expected engine_schedule_deregistered/once_complete, got: %v", eventTypes(collected))
	}
}
