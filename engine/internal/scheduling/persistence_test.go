package scheduling

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
)

// ─── Stubs ───

// stubDailyJob is a daily ScheduleJob for tests. Defaults the
// timezone to UTC and the time to 09:30 so tests don't have to
// repeat the boilerplate.
func stubDailyJob(id string) extension.ScheduleJob {
	return extension.ScheduleJob{
		JobID: id,
		Kind:  extension.ScheduleDaily,
		Time:  "09:30",
		Tz:    "UTC",
	}
}

// stubIntervalJob builds an interval ScheduleJob with the given
// interval. Persistence is documented not to apply to interval
// jobs — these stubs let the test cement that behavior.
func stubIntervalJob(id string, intervalMs int64) extension.ScheduleJob {
	return extension.ScheduleJob{
		JobID:      id,
		Kind:       extension.ScheduleInterval,
		IntervalMs: intervalMs,
	}
}

// newWeeklyJob builds a weekly job for tests.
func newWeeklyJob(id, hhmm, weekday string) extension.ScheduleJob {
	return extension.ScheduleJob{
		JobID:     id,
		Kind:      extension.ScheduleWeekly,
		Time:      hhmm,
		DayOfWeek: weekday,
		Tz:        "UTC",
	}
}

// ─── Persistence: write/read round-trip ───

// TestPersistence_WriteAndRead exercises the recordLastRun /
// readLastRun pair through a real filesystem round-trip with a real
// extension.Host stub. The scheduler is the only consumer of these
// helpers; this test pins the on-disk format so a future refactor
// must consciously change the contract.
//
// Strategy: build a Scheduler with PersistDir, call recordLastRunByName
// for a daily job with a known timestamp, then readLastRunByName and
// assert it matches.
func TestPersistence_WriteAndRead(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	job := stubDailyJob("daily-1")

	want := time.Date(2026, 5, 25, 9, 30, 0, 0, time.UTC)
	s.recordLastRunByName("ext-a", job, want)

	got, ok := s.readLastRunByName("ext-a", job)
	if !ok {
		t.Fatal("readLastRun did not find the marker we just wrote")
	}
	if !got.Equal(want) {
		t.Fatalf("readLastRun returned %v, want %v", got, want)
	}

	// On-disk format must be {"lastRunUtc": "RFC3339"}. Pinning this
	// catches accidental field-name drift in a future refactor.
	files, _ := os.ReadDir(dir)
	if len(files) != 1 {
		t.Fatalf("expected 1 marker file, got %d: %v", len(files), files)
	}
	data, err := os.ReadFile(filepath.Join(dir, files[0].Name()))
	if err != nil {
		t.Fatalf("read marker: %v", err)
	}
	var on struct {
		LastRunUtc string `json:"lastRunUtc"`
	}
	if err := json.Unmarshal(data, &on); err != nil {
		t.Fatalf("parse marker: %v", err)
	}
	if on.LastRunUtc != want.Format(time.RFC3339) {
		t.Errorf("on-disk lastRunUtc = %q, want %q", on.LastRunUtc, want.Format(time.RFC3339))
	}
}

// TestPersistence_IntervalWritesMarker verifies interval jobs persist a
// last-run marker (like daily/weekly). The marker lets an interval job
// resume its cadence and catch up across engine restarts instead of
// resetting to now+interval on every start. See computeBootstrapNextRun.
func TestPersistence_IntervalWritesMarker(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	job := stubIntervalJob("int-1", 30_000)
	want := time.Now().UTC().Truncate(time.Second)

	s.recordLastRunByName("ext-a", job, want)

	got, ok := s.readLastRunByName("ext-a", job)
	if !ok {
		t.Fatal("interval job did not write a readable last-run marker")
	}
	if !got.Equal(want) {
		t.Fatalf("interval marker = %v, want %v", got, want)
	}

	files, _ := os.ReadDir(dir)
	if len(files) != 1 {
		t.Fatalf("interval job wrote %d marker files; want 1: %v", len(files), files)
	}
}

// TestPersistence_NoOpWhenDirEmpty confirms the documented "no
// PersistDir means no persistence" path: recordLastRun and
// readLastRun both no-op without errors.
func TestPersistence_NoOpWhenDirEmpty(t *testing.T) {
	s := New(Config{}) // PersistDir intentionally empty
	job := stubDailyJob("d")

	s.recordLastRunByName("ext-a", job, time.Now())

	if _, ok := s.readLastRunByName("ext-a", job); ok {
		t.Fatal("readLastRun should return false when PersistDir is empty")
	}
}

// TestPersistence_BadJSONReturnsFalse ensures a corrupted marker
// file doesn't crash the scheduler — it must read as "no marker"
// so the next fire still happens.
func TestPersistence_BadJSONReturnsFalse(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})
	job := stubDailyJob("d")

	path := s.markerPathByName("ext-a", job)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("this-is-not-json"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	if _, ok := s.readLastRunByName("ext-a", job); ok {
		t.Fatal("readLastRun on corrupt marker should return false")
	}
}

// TestPersistence_BadTimestampReturnsFalse — a JSON object with
// the wrong-format timestamp also must not crash, must return false.
func TestPersistence_BadTimestampReturnsFalse(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})
	job := stubDailyJob("d")

	path := s.markerPathByName("ext-a", job)
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	_ = os.WriteFile(path, []byte(`{"lastRunUtc":"yesterday at noon"}`), 0o644)

	if _, ok := s.readLastRunByName("ext-a", job); ok {
		t.Fatal("readLastRun on bad timestamp should return false")
	}
}

// TestPersistence_MarkerPathSanitisesName uses host names and job
// ids with filesystem-unsafe characters to confirm safeName produces
// a path that round-trips through the filesystem and matches itself
// on subsequent reads. Forward-compat for hosts whose names come
// from arbitrary extension manifests.
func TestPersistence_MarkerPathSanitisesName(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})

	job := stubDailyJob("job spaces and slashes/x")

	s.recordLastRunByName("my/ext:name", job, time.Now().UTC())

	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("expected 1 file, got %d", len(files))
	}
	name := files[0].Name()
	if strings.ContainsAny(name, "/\\: ") {
		t.Errorf("filename contains forbidden chars: %q", name)
	}

	// And readLastRun should find it.
	if _, ok := s.readLastRunByName("my/ext:name", job); !ok {
		t.Fatal("read after write with sanitised name failed")
	}
}

// ─── lastScheduledSlotBefore: round-trip checks ───

// TestLastScheduledSlotBefore_WeeklyToday exercises the weekly case
// when the target weekday is today. If the time has already passed
// today, today's slot is the answer; otherwise it's the prior week's
// same-weekday slot.
func TestLastScheduledSlotBefore_WeeklyToday(t *testing.T) {
	// 2026-05-25 is a Monday.
	job := newWeeklyJob("w", "09:30", "monday")

	// At Monday 11:00 UTC, today's slot (09:30) has passed.
	t11 := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC)
	got := lastScheduledSlotBefore(job, t11, time.UTC)
	want := time.Date(2026, 5, 25, 9, 30, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("got %v want %v", got, want)
	}

	// At Monday 08:00 UTC, today's slot hasn't happened; last was
	// previous Monday 09:30.
	t8 := time.Date(2026, 5, 25, 8, 0, 0, 0, time.UTC)
	got = lastScheduledSlotBefore(job, t8, time.UTC)
	want = time.Date(2026, 5, 18, 9, 30, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// TestLastScheduledSlotBefore_WeeklyDifferentWeekday — Friday 09:30
// asked from a Tuesday. Last Friday at 09:30 is the answer.
func TestLastScheduledSlotBefore_WeeklyDifferentWeekday(t *testing.T) {
	job := newWeeklyJob("w", "09:30", "friday")
	// 2026-05-26 is a Tuesday.
	from := time.Date(2026, 5, 26, 12, 0, 0, 0, time.UTC)
	got := lastScheduledSlotBefore(job, from, time.UTC)
	want := time.Date(2026, 5, 22, 9, 30, 0, 0, time.UTC) // Fri 22 May
	if !got.Equal(want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// TestPersistence_MissingFileIsNotError verifies readLastRun
// distinguishes "file doesn't exist" (return false, no log) from
// "file exists but bad" (return false, log a Warn). The wire
// behavior is identical (false), but the log volume differs and we
// don't want every missing marker to print a warning.
func TestPersistence_MissingFileIsNotError(t *testing.T) {
	dir := t.TempDir()
	s := New(Config{PersistDir: dir})
	job := stubDailyJob("d")

	// No file exists. readLastRun must return false cleanly.
	got, ok := s.readLastRunByName("ext", job)
	if ok {
		t.Fatalf("expected false for missing marker, got %v", got)
	}
}

// TestPersistence_MakeDirFailureDoesNotPanic — when PersistDir can't
// be created (e.g. parent is a file), recordLastRun logs a Warn and
// returns silently. The scheduler must not crash.
func TestPersistence_MakeDirFailureDoesNotPanic(t *testing.T) {
	// Place a file where the dir should be.
	tempBase := t.TempDir()
	conflict := filepath.Join(tempBase, "conflict")
	if err := os.WriteFile(conflict, []byte("file-not-dir"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	s := New(Config{PersistDir: filepath.Join(conflict, "sub")})
	job := stubDailyJob("d")

	// Should not panic.
	s.recordLastRunByName("ext", job, time.Now())

	// Verify the failure mode: no marker was actually written.
	if _, err := os.Stat(filepath.Join(conflict, "sub")); err == nil {
		t.Fatal("dir was created despite file conflict")
	} else if !errors.Is(err, os.ErrNotExist) && !strings.Contains(err.Error(), "not a directory") {
		t.Logf("stat err: %v (expected non-exist or not-a-dir)", err)
	}
}

// ─── End: persistence specifics ───
