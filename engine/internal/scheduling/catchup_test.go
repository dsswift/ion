package scheduling

import (
	"testing"
	"time"
)

// TestCatchUp_MissedDailySchedulesCatchUp simulates an engine restart
// after a missed daily slot. We pre-populate a last-run marker
// dated two days ago, then call computeBootstrapNextRun and verify
// the scheduler queues a catch-up fire (next-run within 30-31s of now).
//
// This test exercises:
//   - readLastRunByName finds the persisted marker
//   - lastScheduledSlotBefore correctly identifies the missed slot
//   - bootstrap decides "missed slot" and schedules catch-up with
//     the documented 30s stagger
//
// We exercise computeBootstrapNextRun rather than bootstrapNextRun
// because the former takes a host-name string and the latter needs
// a real *extension.Host. The math (and the catch-up decision) is
// identical between the two; bootstrapNextRun is a thin wrapper.
func TestCatchUp_MissedDailySchedulesCatchUp(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	// Use a fixed "now" so the test is deterministic regardless of
	// wall-clock when CI runs it.
	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC) // 11:00 UTC on a Monday

	job := stubDailyJob("d") // fires at 09:30 UTC daily

	// Write a marker dated two days ago. That means yesterday's slot
	// AND today's 09:30 slot were both missed.
	twoDaysAgo := now.Add(-48 * time.Hour)
	s.recordLastRunByName("ext-a", job, twoDaysAgo)

	loc := s.loadTz(jobTz(job))
	next := s.computeBootstrapNextRun("ext-a", job, now, loc)

	// Catch-up scheduled "now + 30s" stagger.
	stagger := next.Sub(now)
	if stagger < 25*time.Second || stagger > 35*time.Second {
		t.Errorf("catch-up stagger should be ~30s; got %s", stagger)
	}
}

// TestCatchUp_NoMissedSlotSchedulesNormalNextRun confirms that when
// the last-run marker is *after* the most recent scheduled slot,
// catch-up is NOT triggered — next-run goes to the next regular
// slot (tomorrow's 09:30).
func TestCatchUp_NoMissedSlotSchedulesNormalNextRun(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC) // 11:00 Mon

	job := stubDailyJob("d")
	// Marker is from this morning at 09:30 (the scheduled slot ran
	// successfully before the engine restarted).
	thisMorning := time.Date(2026, 5, 25, 9, 30, 0, 0, time.UTC)
	s.recordLastRunByName("ext-a", job, thisMorning)

	loc := s.loadTz(jobTz(job))
	next := s.computeBootstrapNextRun("ext-a", job, now, loc)

	// Should be tomorrow at 09:30, NOT now+30s.
	want := time.Date(2026, 5, 26, 9, 30, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Errorf("next-run = %v, want %v (tomorrow's slot, not a catch-up)", next, want)
	}
}

// TestCatchUp_CatchUpDisabledByConfig confirms config can turn off
// catch-up. With CatchUpEnabled = false, even a missed slot should
// schedule the normal next slot rather than a stagger-now fire.
func TestCatchUp_CatchUpDisabledByConfig(t *testing.T) {
	off := false
	dir := t.TempDir()
	s := New(Config{PersistDir: dir, CatchUpEnabled: &off})

	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC)

	job := stubDailyJob("d")
	twoDaysAgo := now.Add(-48 * time.Hour)
	s.recordLastRunByName("ext-a", job, twoDaysAgo)

	loc := s.loadTz(jobTz(job))
	next := s.computeBootstrapNextRun("ext-a", job, now, loc)

	// With catch-up disabled, next-run is tomorrow's 09:30, not now+30s.
	want := time.Date(2026, 5, 26, 9, 30, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Errorf("next-run with catch-up off = %v, want %v", next, want)
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
	next := s.computeBootstrapNextRun("ext-a", job, now, loc)

	// No marker → exactly now + intervalMs.
	want := now.Add(60 * time.Second)
	if !next.Equal(want) {
		t.Errorf("interval next-run with no marker = %v, want %v", next, want)
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
	next := s.computeBootstrapNextRun("ext-a", job, now, loc)

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
	next := s.computeBootstrapNextRun("ext-a", job, now, loc)

	want := lastRun.Add(2 * time.Hour)
	if !next.Equal(want) {
		t.Errorf("not-yet-due interval next-run = %v, want %v (lastRun+interval)", next, want)
	}
}

// TestCatchUp_NoMarkerSchedulesNextSlot — when no last-run marker
// exists at all (first run after install), the bootstrap path
// schedules the next regular slot.
func TestCatchUp_NoMarkerSchedulesNextSlot(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC) // Mon 11:00

	job := stubDailyJob("d")

	loc := s.loadTz(jobTz(job))
	next := s.computeBootstrapNextRun("ext-a", job, now, loc)

	// No marker → tomorrow's 09:30 (since today's already passed at 11:00).
	want := time.Date(2026, 5, 26, 9, 30, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Errorf("next-run with no marker = %v, want %v", next, want)
	}
}

// TestCatchUp_WeeklyMissedSlot — same catch-up semantics for weekly.
// Weekly job: Monday 09:30. Pretend we restarted on Tuesday with no
// marker since last Friday — the Monday slot was missed.
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
	next := s.computeBootstrapNextRun("ext-a", job, now, loc)

	// Monday 2026-05-25 09:30 was the most recent slot before now;
	// it's after lastFri → catch-up triggered.
	stagger := next.Sub(now)
	if stagger < 25*time.Second || stagger > 35*time.Second {
		t.Errorf("weekly catch-up stagger should be ~30s; got %s", stagger)
	}
}
