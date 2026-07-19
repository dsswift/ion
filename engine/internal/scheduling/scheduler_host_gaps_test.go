// Tests for #285 (sibling-cadence inheritance on host replacement) and
// #280 (engine_schedule_unhosted emission when last alive host removed).

package scheduling

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// ─── #285: sibling-cadence inheritance ──────────────────────────────────────

// TestBootstrap_InheritsSiblingNextRun verifies that when a host is added and
// a sibling host (same extension name, same job ID) has previously fired on
// cadence, the new host inherits the accumulated nextRun value rather than
// resetting to now+interval when it first becomes first-alive.
//
// The inheritance point is the first tick after the departing host is removed:
// when the new host becomes first-alive in the single-concurrency group, its
// bootstrapNextRun inherits the extNextRun value left behind by the old host.
func TestBootstrap_InheritsSiblingNextRun(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "morning-brief",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 60_000, // 1 minute
	}

	baseTime := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)

	// Set up scheduler with host A — bootstrap, so A has a populated nextRun.
	hostA := testHostWithSchedule(t, "ion-dev", job)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) {})
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "test"}, nil
	})
	s.nowFn = func() time.Time { return baseTime }
	s.AddHost(hostA)
	s.tickOnce() // bootstrap hostA: extNextRun[{ion-dev, morning-brief}] = baseTime+60s

	// Verify extNextRun was set from hostA's bootstrap.
	extKey := extensionJobKey{name: "ion-dev", id: job.JobID}
	s.mu.RLock()
	extNext := s.extNextRun[extKey]
	s.mu.RUnlock()
	wantNext := baseTime.Add(60 * time.Second)
	if !extNext.Equal(wantNext) {
		t.Fatalf("extNextRun after hostA bootstrap = %v, want %v", extNext, wantNext)
	}

	// Simulate host replacement mid-cadence: remove hostA, add hostB.
	s.RemoveHost(hostA)
	hostB := testHostWithSchedule(t, "ion-dev", job)
	s.AddHost(hostB)

	// Advance time to before the next-run (hostA would have fired at baseTime+60s).
	midpoint := baseTime.Add(30 * time.Second)
	s.nowFn = func() time.Time { return midpoint }

	// tickOnce: hostB is now first-alive, maybeFire is called, bootstrapNextRun
	// inherits extNextRun[{ion-dev, morning-brief}] = baseTime+60s.
	s.tickOnce()

	keyB := hostJobKey{host: hostB, id: job.JobID}
	s.mu.RLock()
	nextB, ok := s.nextRun[keyB]
	s.mu.RUnlock()
	if !ok {
		t.Fatal("hostB nextRun not set after tick")
	}

	// Must inherit the sibling's cadence, not compute a fresh midpoint+60s.
	freshReset := midpoint.Add(60 * time.Second)
	if !nextB.Equal(wantNext) {
		t.Errorf("hostB nextRun = %v; want inherited %v (fresh reset would be %v)",
			nextB, wantNext, freshReset)
	}
}

// TestBootstrap_NoSiblingFallsBackToFresh verifies that when no sibling entry
// exists, bootstrapNextRun computes a fresh now+interval as before.
func TestBootstrap_NoSiblingFallsBackToFresh(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "solo-job",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 60_000,
	}

	baseTime := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	h := testHostWithSchedule(t, "ion-dev", job)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) {})
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "test"}, nil
	})
	s.nowFn = func() time.Time { return baseTime }
	s.AddHost(h)
	s.tickOnce() // bootstrap — no sibling exists

	key := hostJobKey{host: h, id: job.JobID}
	s.mu.RLock()
	next, ok := s.nextRun[key]
	s.mu.RUnlock()
	if !ok {
		t.Fatal("nextRun not set")
	}

	want := baseTime.Add(60 * time.Second)
	if !next.Equal(want) {
		t.Errorf("nextRun = %v, want %v (fresh now+interval)", next, want)
	}
}

// TestBootstrap_SiblingInheritSurvivesRemoval verifies the full host-replacement
// cycle: hostA fires on cadence, hostA is removed, hostB inherits the cadence.
// After removal, hostB should fire at the originally-expected next-run time, not
// at a reset now+interval.
func TestBootstrap_SiblingInheritSurvivesRemoval(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "briefing",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 1000, // 1 s for test speed
	}

	baseTime := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)

	// Start with just hostA.
	hostA := testHostWithSchedule(t, "ion-dev", job)
	events := make(chan types.EngineEvent, 32)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) { events <- ev })
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "test"}, nil
	})
	s.nowFn = func() time.Time { return baseTime }
	s.AddHost(hostA)
	s.tickOnce() // bootstrap hostA: extNextRun set to baseTime+1s

	wantNextRun := baseTime.Add(time.Second)

	// Verify hostA's nextRun was set.
	keyA := hostJobKey{host: hostA, id: job.JobID}
	s.mu.RLock()
	nextA := s.nextRun[keyA]
	s.mu.RUnlock()
	if !nextA.Equal(wantNextRun) {
		t.Fatalf("hostA nextRun = %v, want %v", nextA, wantNextRun)
	}

	// Remove hostA (session teardown) and add hostB (new session).
	s.RemoveHost(hostA)
	hostB := testHostWithSchedule(t, "ion-dev", job)
	s.AddHost(hostB)

	// Tick at midpoint (before the due time) — hostB bootstraps and should
	// inherit extNextRun[{ion-dev, briefing}] = wantNextRun.
	midpoint := baseTime.Add(500 * time.Millisecond)
	s.nowFn = func() time.Time { return midpoint }
	s.tickOnce()

	keyB := hostJobKey{host: hostB, id: job.JobID}
	s.mu.RLock()
	nextBAfter := s.nextRun[keyB]
	s.mu.RUnlock()
	if !nextBAfter.Equal(wantNextRun) {
		t.Errorf("hostB nextRun after removal = %v, want preserved %v (fresh would be %v)",
			nextBAfter, wantNextRun, midpoint.Add(time.Second))
	}

	// Advance past the due time and verify hostB fires (cadence preserved).
	// In the unit test environment hosts have no loaded subprocess, so FireAsync
	// fails and engine_schedule_failed is emitted — not engine_schedule_fired.
	// Both prove the cadence was preserved and a fire was attempted at the
	// inherited next-run time, not at a fresh now+interval.
	s.nowFn = func() time.Time { return baseTime.Add(2 * time.Second) }
	drainEvents(events)
	s.tickOnce()
	time.Sleep(200 * time.Millisecond)
	fired := drainEvents(events)
	var sawFire bool
	for _, ev := range fired {
		if (ev.Type == "engine_schedule_fired" || ev.Type == "engine_schedule_failed") && ev.AsyncID == job.JobID {
			sawFire = true
		}
	}
	if !sawFire {
		t.Errorf("hostB did not attempt fire after hostA removal; events: %v", eventTypes(fired))
	}
}

// ─── #280: engine_schedule_unhosted ─────────────────────────────────────────

// TestRemoveHost_EmitsUnhostedWhenLastAliveRemoved verifies that when the last
// alive host for a (extension, jobID) group is removed, RemoveHost emits
// engine_schedule_unhosted so consumers can observe and alert on the gap.
func TestRemoveHost_EmitsUnhostedWhenLastAliveRemoved(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "daily-digest",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 60_000,
	}

	h := testHostWithSchedule(t, "ion-dev", job)
	events := make(chan types.EngineEvent, 32)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) { events <- ev })
	s.AddHost(h)

	s.RemoveHost(h)
	time.Sleep(50 * time.Millisecond) // brief yield for emit goroutine if any

	collected := drainEvents(events)
	var sawUnhosted bool
	for _, ev := range collected {
		if ev.Type == "engine_schedule_unhosted" && ev.AsyncID == job.JobID {
			sawUnhosted = true
		}
	}
	if !sawUnhosted {
		t.Fatalf("expected engine_schedule_unhosted when last host removed, got: %v", eventTypes(collected))
	}
}

// TestRemoveHost_NoUnhostedWhileSiblingAlive verifies that engine_schedule_unhosted
// is NOT emitted when a sibling alive host still carries the job — only the
// transition to zero alive hosts should produce the event.
func TestRemoveHost_NoUnhostedWhileSiblingAlive(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "daily-digest",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 60_000,
	}

	hostA := testHostWithSchedule(t, "ion-dev", job)
	hostB := testHostWithSchedule(t, "ion-dev", job)
	events := make(chan types.EngineEvent, 32)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) { events <- ev })
	s.AddHost(hostA)
	s.AddHost(hostB)

	// Remove hostA — hostB is still alive and carries the same job.
	s.RemoveHost(hostA)
	time.Sleep(50 * time.Millisecond)

	collected := drainEvents(events)
	for _, ev := range collected {
		if ev.Type == "engine_schedule_unhosted" && ev.AsyncID == job.JobID {
			t.Errorf("engine_schedule_unhosted must not fire while sibling hostB is alive: %+v", ev)
		}
	}

	// Remove hostB — now the group is empty, event must fire.
	s.RemoveHost(hostB)
	time.Sleep(50 * time.Millisecond)

	collected = drainEvents(events)
	var sawUnhosted bool
	for _, ev := range collected {
		if ev.Type == "engine_schedule_unhosted" && ev.AsyncID == job.JobID {
			sawUnhosted = true
		}
	}
	if !sawUnhosted {
		t.Fatalf("expected engine_schedule_unhosted after both hosts removed, got: %v", eventTypes(collected))
	}
}

// TestRemoveHost_NoUnhostedForDeadSibling verifies that a Dead() sibling host
// is not counted as alive — only truly alive peers suppress the unhosted event.
func TestRemoveHost_NoUnhostedForDeadSibling(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "hourly-check",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 3_600_000,
	}

	hostA := testHostWithSchedule(t, "ion-dev", job)
	hostB := testHostWithSchedule(t, "ion-dev", job)
	// Mark hostB dead — it is registered but not alive.
	hostB.MarkDeadForTest()

	events := make(chan types.EngineEvent, 32)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) { events <- ev })
	s.AddHost(hostA)
	s.AddHost(hostB)

	// Remove hostA. The only remaining host (hostB) is Dead, so the group is
	// effectively unhosted — event must fire.
	s.RemoveHost(hostA)
	time.Sleep(50 * time.Millisecond)

	collected := drainEvents(events)
	var sawUnhosted bool
	for _, ev := range collected {
		if ev.Type == "engine_schedule_unhosted" && ev.AsyncID == job.JobID {
			sawUnhosted = true
		}
	}
	if !sawUnhosted {
		t.Fatalf("expected engine_schedule_unhosted when only dead sibling remains, got: %v", eventTypes(collected))
	}
}

// TestRemoveHost_UnhostedCarriesCorrectAsyncKind verifies the wire shape of
// engine_schedule_unhosted: AsyncKind must be "schedule" and AsyncID must be
// the job ID. This pins the contract so a consumer building on it doesn't
// regress silently.
func TestRemoveHost_UnhostedCarriesCorrectAsyncKind(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "ping",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 10_000,
	}

	h := testHostWithSchedule(t, "ion-dev", job)
	events := make(chan types.EngineEvent, 32)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) { events <- ev })
	s.AddHost(h)
	s.RemoveHost(h)
	time.Sleep(50 * time.Millisecond)

	for _, ev := range drainEvents(events) {
		if ev.Type != "engine_schedule_unhosted" {
			continue
		}
		if ev.AsyncKind != string(asyncreg.KindSchedule) {
			t.Errorf("AsyncKind = %q, want %q", ev.AsyncKind, asyncreg.KindSchedule)
		}
		if ev.AsyncID != job.JobID {
			t.Errorf("AsyncID = %q, want %q", ev.AsyncID, job.JobID)
		}
		return
	}
	t.Fatal("engine_schedule_unhosted not emitted")
}

// ─── extNextRun lifecycle (align fix: prune at deregistration seams) ────────

// TestExtNextRun_PrunedOnCancelThenReregister pins the cancel→re-register
// path: an interval job cancelled via schedule.cancel (registry deregister)
// while its host stays alive must NOT leave a stale extNextRun entry behind —
// a job re-registered under the same ID would inherit the stale (possibly
// past) next-run through bootstrapNextRun's sibling-inherit branch and fire
// immediately. Fails on the unpruned code.
func TestExtNextRun_PrunedOnCancelThenReregister(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "cancel-me",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 60_000,
	}

	baseTime := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	h := testHostWithSchedule(t, "ion-dev", job)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) {})
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "test"}, nil
	})
	s.nowFn = func() time.Time { return baseTime }
	s.AddHost(h)
	s.tickOnce() // bootstrap: extNextRun = baseTime+60s

	extKey := extensionJobKey{name: "ion-dev", id: job.JobID}
	s.mu.RLock()
	seeded := s.extNextRun[extKey]
	s.mu.RUnlock()
	if seeded.IsZero() {
		t.Fatal("precondition: extNextRun not seeded by bootstrap")
	}

	// Cancel the job (host stays alive) — the tick must prune the entry.
	if !h.DeregisterScheduleDeclSilent(job.JobID) {
		t.Fatal("precondition: deregister failed")
	}
	s.tickOnce()

	s.mu.RLock()
	afterCancel := s.extNextRun[extKey]
	s.mu.RUnlock()
	if !afterCancel.IsZero() {
		t.Fatalf("extNextRun entry survived cancel: %v — a re-registered job would inherit it and fire immediately", afterCancel)
	}

	// Re-register the same job ID much later: bootstrap must compute a
	// fresh now+interval, not inherit the pre-cancel cadence.
	if err := h.AsyncRegistry().Register(asyncreg.KindSchedule, job, asyncreg.OriginRuntime, nil); err != nil {
		t.Fatalf("re-register: %v", err)
	}
	later := baseTime.Add(10 * time.Minute)
	s.nowFn = func() time.Time { return later }
	s.tickOnce()

	key := hostJobKey{host: h, id: job.JobID}
	s.mu.RLock()
	next := s.nextRun[key]
	s.mu.RUnlock()
	want := later.Add(60 * time.Second)
	if !next.Equal(want) {
		t.Errorf("re-registered job nextRun = %v, want fresh %v (stale inherit would be %v)",
			next, want, seeded)
	}
}

// TestExtNextRun_SurvivesHostReplacementWindow guards the prune from
// over-reaching: while NO alive host of the extension exists (session
// teardown, successor not yet created), the extNextRun entry is load-bearing —
// it is exactly what the successor inherits (#285). A tick during that window
// must keep it, and the successor must still inherit.
func TestExtNextRun_SurvivesHostReplacementWindow(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "replace-me",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 60_000,
	}

	baseTime := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	hostA := testHostWithSchedule(t, "ion-dev", job)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) {})
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "test"}, nil
	})
	s.nowFn = func() time.Time { return baseTime }
	s.AddHost(hostA)
	s.tickOnce() // bootstrap: extNextRun = baseTime+60s
	wantNext := baseTime.Add(60 * time.Second)

	// Teardown with no successor yet, then tick INSIDE the window.
	s.RemoveHost(hostA)
	s.nowFn = func() time.Time { return baseTime.Add(10 * time.Second) }
	s.tickOnce()

	extKey := extensionJobKey{name: "ion-dev", id: job.JobID}
	s.mu.RLock()
	survived := s.extNextRun[extKey]
	s.mu.RUnlock()
	if !survived.Equal(wantNext) {
		t.Fatalf("extNextRun pruned during the replacement window: got %v, want %v — the successor host can no longer inherit cadence (#285 regression)", survived, wantNext)
	}

	// Successor appears and must inherit.
	hostB := testHostWithSchedule(t, "ion-dev", job)
	s.AddHost(hostB)
	s.nowFn = func() time.Time { return baseTime.Add(30 * time.Second) }
	s.tickOnce()

	keyB := hostJobKey{host: hostB, id: job.JobID}
	s.mu.RLock()
	nextB := s.nextRun[keyB]
	s.mu.RUnlock()
	if !nextB.Equal(wantNext) {
		t.Errorf("successor nextRun = %v, want inherited %v", nextB, wantNext)
	}
}

// TestExtNextRun_PrunedOnOnceDeregister pins the once-job seam: after a once
// job fires and self-deregisters, its extNextRun entry is dropped so a future
// job under the same ID bootstraps fresh instead of inheriting the spent shot.
func TestExtNextRun_PrunedOnOnceDeregister(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:   "one-shot",
		Kind:    extension.ScheduleOnce,
		DelayMs: 1, // due almost immediately
	}

	baseTime := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	h := testHostWithSchedule(t, "ion-dev", job)
	events := make(chan types.EngineEvent, 32)
	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) { events <- ev })
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "test"}, nil
	})
	s.nowFn = func() time.Time { return baseTime }
	s.AddHost(h)
	s.tickOnce() // bootstrap seeds extNextRun

	extKey := extensionJobKey{name: "ion-dev", id: job.JobID}
	s.mu.RLock()
	seeded := s.extNextRun[extKey]
	s.mu.RUnlock()
	if seeded.IsZero() {
		t.Fatal("precondition: extNextRun not seeded for once job")
	}

	// Advance past the delay and fire. The unit-test host has no loaded
	// subprocess so FireAsync fails, but once jobs deregister on failure
	// too (shot spent) — the seam under test.
	s.nowFn = func() time.Time { return baseTime.Add(time.Second) }
	s.tickOnce()
	time.Sleep(200 * time.Millisecond) // fire runs on a goroutine

	s.mu.RLock()
	after := s.extNextRun[extKey]
	s.mu.RUnlock()
	if !after.IsZero() {
		t.Fatalf("extNextRun entry survived once-job deregistration: %v", after)
	}
}
