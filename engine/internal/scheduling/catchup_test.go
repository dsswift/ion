package scheduling

import (
	"testing"
	"time"
)

// TestCatchUp_MissedDailySchedulesCatchUp simulates an engine restart
// after a missed daily slot. We pre-populate a last-run marker
// dated two days ago, then call computeBootstrapNextRun and verify
// the scheduler queues a catch-up fire (next-run within 30-31s of now)
// when no schedule_missed hook is registered (hasMissedHook=false).
func TestCatchUp_MissedDailySchedulesCatchUp(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC) // 11:00 UTC on a Monday

	job := stubDailyJob("d") // fires at 09:30 UTC daily

	// Write a marker dated two days ago with LastRunUtc set.
	twoDaysAgo := now.Add(-48 * time.Hour)
	s.recordLastRunByName("ext-a", job, twoDaysAgo)

	loc := s.loadTz(jobTz(job))
	next, decision := s.computeBootstrapNextRun("ext-a", job, now, loc, false)

	// Catch-up scheduled "now + 30s" stagger.
	stagger := next.Sub(now)
	if stagger < 25*time.Second || stagger > 35*time.Second {
		t.Errorf("catch-up stagger should be ~30s; got %s", stagger)
	}
	if decision != nil {
		t.Error("decision should be nil when hasMissedHook=false")
	}
}

// TestCatchUp_NoMissedSlotSchedulesNormalNextRun confirms that when
// the last-run marker is *after* the most recent scheduled slot,
// catch-up is NOT triggered.
func TestCatchUp_NoMissedSlotSchedulesNormalNextRun(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC) // 11:00 Mon

	job := stubDailyJob("d")
	thisMorning := time.Date(2026, 5, 25, 9, 30, 0, 0, time.UTC)
	s.recordLastRunByName("ext-a", job, thisMorning)

	loc := s.loadTz(jobTz(job))
	next, decision := s.computeBootstrapNextRun("ext-a", job, now, loc, false)

	want := time.Date(2026, 5, 26, 9, 30, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Errorf("next-run = %v, want %v (tomorrow's slot, not a catch-up)", next, want)
	}
	if decision != nil {
		t.Error("decision should be nil when slot was not missed")
	}
}

// TestCatchUp_CatchUpDisabledByConfig confirms config can turn off
// catch-up.
func TestCatchUp_CatchUpDisabledByConfig(t *testing.T) {
	off := false
	dir := t.TempDir()
	s := New(Config{PersistDir: dir, CatchUpEnabled: &off})

	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC)

	job := stubDailyJob("d")
	twoDaysAgo := now.Add(-48 * time.Hour)
	s.recordLastRunByName("ext-a", job, twoDaysAgo)

	loc := s.loadTz(jobTz(job))
	next, decision := s.computeBootstrapNextRun("ext-a", job, now, loc, false)

	want := time.Date(2026, 5, 26, 9, 30, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Errorf("next-run with catch-up off = %v, want %v", next, want)
	}
	if decision != nil {
		t.Error("decision should be nil when catch-up disabled")
	}
}

// TestCatchUp_IntervalNoMarkerSchedulesNextRun — an interval job with no
// last-run marker (first run ever) schedules the normal now+interval
// next-run. Catch-up needs a marker to compare against, so a fresh job
// waits its first full interval — no thundering herd on a fresh install.
func TestCatchUp_IntervalNoMarkerSchedulesNextRun(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC)

	job := stubIntervalJob("int", 60_000) // 1 minute

	loc := s.loadTz(jobTz(job))
	next, decision := s.computeBootstrapNextRun("ext-a", job, now, loc, false)

	// No marker → exactly now + intervalMs.
	want := now.Add(60 * time.Second)
	if !next.Equal(want) {
		t.Errorf("interval next-run with no marker = %v, want %v", next, want)
	}
	if decision != nil {
		t.Error("decision should be nil for interval")
	}
}

// TestCatchUp_IntervalCatchesUpWhenOverdue — after a restart, an interval
// job whose last run is more than one interval ago is overdue and must be
// scheduled to fire ~now (staggered), not a full interval out. This is the
// fix for interval jobs starving on frequently-restarting engines: without
// it, every restart reset next-run to now+interval so a job whose interval
// exceeds mean uptime never fired.
func TestCatchUp_IntervalCatchesUpWhenOverdue(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC)
	job := stubIntervalJob("int", (2 * time.Hour).Milliseconds()) // 2h

	// Last run 5h ago — more than one interval → overdue.
	s.recordLastRunByName("ext-a", job, now.Add(-5*time.Hour))

	loc := s.loadTz(jobTz(job))
	next, _ := s.computeBootstrapNextRun("ext-a", job, now, loc, false)

	want := now.Add(CatchUpStagger)
	if !next.Equal(want) {
		t.Errorf("overdue interval next-run = %v, want %v (now+stagger)", next, want)
	}
}

// TestCatchUp_IntervalResumesCadenceWhenNotOverdue — an interval job whose
// last run is less than one interval ago resumes its original cadence
// (lastRun+interval) across the restart, rather than resetting to
// now+interval (which would drift the schedule later on every restart).
func TestCatchUp_IntervalResumesCadenceWhenNotOverdue(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC)
	job := stubIntervalJob("int", (2 * time.Hour).Milliseconds()) // 2h

	// Last run 30m ago — not yet due; next slot is lastRun+2h.
	lastRun := now.Add(-30 * time.Minute)
	s.recordLastRunByName("ext-a", job, lastRun)

	loc := s.loadTz(jobTz(job))
	next, decision := s.computeBootstrapNextRun("ext-a", job, now, loc, false)

	want := lastRun.Add(2 * time.Hour)
	if !next.Equal(want) {
		t.Errorf("not-yet-due interval next-run = %v, want %v (lastRun+interval)", next, want)
	}
	if decision != nil {
		t.Error("decision should be nil for interval")
	}
}

// TestCatchUp_FirstSightingDoesNotCatchUp — truly no marker at all,
// elapsed slot, hasMissedHook=false: next = tomorrow's slot (NOT
// stagger), and a FirstSeen marker is written. This is the flood guard.
func TestCatchUp_FirstSightingDoesNotCatchUp(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC) // Mon 11:00

	job := stubDailyJob("d")

	loc := s.loadTz(jobTz(job))
	next, decision := s.computeBootstrapNextRun("ext-a", job, now, loc, false)

	// No marker: first sighting. Should record FirstSeen and NOT catch up.
	want := time.Date(2026, 5, 26, 9, 30, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Errorf("next-run with no marker = %v, want %v", next, want)
	}
	if decision != nil {
		t.Error("decision should be nil on first sighting")
	}

	// Verify FirstSeen marker was written.
	marker, ok := s.readMarker("ext-a", job)
	if !ok {
		t.Fatal("expected a marker to be written on first sighting")
	}
	if marker.FirstSeenUtc == "" {
		t.Error("FirstSeenUtc should be set")
	}
	if marker.LastRunUtc != "" {
		t.Error("LastRunUtc should be empty on first sighting")
	}
}

// TestCatchUp_NoLastRunMarkerButKnownJobCatchesUp — a job that was
// first-seen BEFORE the missed slot (has FirstSeen-only marker, no
// LastRunUtc), hasMissedHook=false: should catch up with stagger.
func TestCatchUp_NoLastRunMarkerButKnownJobCatchesUp(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC) // Mon 11:00

	job := stubDailyJob("d") // fires at 09:30

	// Pre-seed a FirstSeen-only marker dated yesterday (before today's 09:30).
	yesterday := time.Date(2026, 5, 24, 15, 0, 0, 0, time.UTC)
	s.recordFirstSeenByName("ext-a", job, yesterday)

	loc := s.loadTz(jobTz(job))
	next, decision := s.computeBootstrapNextRun("ext-a", job, now, loc, false)

	// Should auto-catch-up: next = now + stagger.
	stagger := next.Sub(now)
	if stagger < 25*time.Second || stagger > 35*time.Second {
		t.Errorf("expected catch-up stagger ~30s; got %s (next=%v)", stagger, next)
	}
	if decision != nil {
		t.Error("decision should be nil when hasMissedHook=false")
	}
}

// TestCatchUp_NoMarkerWithHookEmitsMissedNoAutoFire — FirstSeen-only
// marker dated before slot, hasMissedHook=true: next = normal slot,
// decision is non-nil.
func TestCatchUp_NoMarkerWithHookEmitsMissedNoAutoFire(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC)

	job := stubDailyJob("d")

	// Pre-seed a FirstSeen-only marker dated yesterday.
	yesterday := time.Date(2026, 5, 24, 15, 0, 0, 0, time.UTC)
	s.recordFirstSeenByName("ext-a", job, yesterday)

	loc := s.loadTz(jobTz(job))
	next, decision := s.computeBootstrapNextRun("ext-a", job, now, loc, true)

	// Normal next slot (NOT stagger).
	want := time.Date(2026, 5, 26, 9, 30, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Errorf("next-run = %v, want %v", next, want)
	}
	if decision == nil {
		t.Fatal("decision should be non-nil when hasMissedHook=true and slot missed")
	}
	// HadMarker should be false (no LastRunUtc).
	if decision.HadMarker {
		t.Error("HadMarker should be false when only FirstSeen is set")
	}
	// Slot should be today's 09:30.
	wantSlot := time.Date(2026, 5, 25, 9, 30, 0, 0, time.UTC)
	if !decision.Slot.Equal(wantSlot) {
		t.Errorf("decision.Slot = %v, want %v", decision.Slot, wantSlot)
	}
}

// TestCatchUp_MarkerMissedWithHookDefers — LastRunUtc marker 2 days ago,
// hasMissedHook=true: next = normal slot, decision != nil, HadMarker=true.
func TestCatchUp_MarkerMissedWithHookDefers(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC)

	job := stubDailyJob("d")

	twoDaysAgo := now.Add(-48 * time.Hour)
	s.recordLastRunByName("ext-a", job, twoDaysAgo)

	loc := s.loadTz(jobTz(job))
	next, decision := s.computeBootstrapNextRun("ext-a", job, now, loc, true)

	want := time.Date(2026, 5, 26, 9, 30, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Errorf("next-run = %v, want %v", next, want)
	}
	if decision == nil {
		t.Fatal("decision should be non-nil")
	}
	if !decision.HadMarker {
		t.Error("HadMarker should be true")
	}
}

// TestCatchUp_RegistrationAnchorBlocksPreExistenceSlot — FirstSeen
// marker dated at noon today, daily slot 09:30 (before noon),
// now=13:00, hasMissedHook=false: NOT caught up (slot predates
// first-sighting) -> next = tomorrow 09:30.
func TestCatchUp_RegistrationAnchorBlocksPreExistenceSlot(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	now := time.Date(2026, 5, 25, 13, 0, 0, 0, time.UTC) // Mon 13:00

	job := stubDailyJob("d") // fires at 09:30

	// FirstSeen marker dated noon today (after 09:30 slot).
	noon := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	s.recordFirstSeenByName("ext-a", job, noon)

	loc := s.loadTz(jobTz(job))
	next, decision := s.computeBootstrapNextRun("ext-a", job, now, loc, false)

	// Today's 09:30 is NOT after noon (the anchor), so no catch-up.
	want := time.Date(2026, 5, 26, 9, 30, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Errorf("next-run = %v, want %v (tomorrow, not catch-up)", next, want)
	}
	if decision != nil {
		t.Error("decision should be nil: slot predates first-sighting")
	}
}

// TestCatchUp_WeeklyMissedSlot — same catch-up semantics for weekly.
func TestCatchUp_WeeklyMissedSlot(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	// 2026-05-26 is a Tuesday.
	now := time.Date(2026, 5, 26, 10, 0, 0, 0, time.UTC)

	job := newWeeklyJob("w", "09:30", "monday")

	// Marker dated last Friday (2026-05-22).
	lastFri := time.Date(2026, 5, 22, 9, 30, 0, 0, time.UTC)
	s.recordLastRunByName("ext-a", job, lastFri)

	loc := s.loadTz(jobTz(job))
	next, decision := s.computeBootstrapNextRun("ext-a", job, now, loc, false)

	// Monday 2026-05-25 09:30 was the most recent slot before now;
	// it's after lastFri -> catch-up triggered.
	stagger := next.Sub(now)
	if stagger < 25*time.Second || stagger > 35*time.Second {
		t.Errorf("weekly catch-up stagger should be ~30s; got %s", stagger)
	}
	if decision != nil {
		t.Error("decision should be nil when hasMissedHook=false")
	}
}
