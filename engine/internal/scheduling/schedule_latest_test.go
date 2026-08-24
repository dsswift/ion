package scheduling

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
)

func TestDailyDaysOfWeek(t *testing.T) {
	job := extension.ScheduleJob{Kind: extension.ScheduleDaily, Time: "09:30", DaysOfWeek: []string{"monday", "wednesday"}}
	from := time.Date(2026, 5, 26, 8, 0, 0, 0, time.UTC) // Tuesday.
	want := time.Date(2026, 5, 27, 9, 30, 0, 0, time.UTC)
	if got := nextRunFor(job, from, time.UTC); !got.Equal(want) {
		t.Fatalf("next filtered daily run = %v, want %v", got, want)
	}
	before := time.Date(2026, 5, 26, 12, 0, 0, 0, time.UTC)
	wantLast := time.Date(2026, 5, 25, 9, 30, 0, 0, time.UTC)
	if got := lastScheduledSlotBefore(job, before, time.UTC); !got.Equal(wantLast) {
		t.Fatalf("last filtered daily slot = %v, want %v", got, wantLast)
	}
}

func TestLatestCatchUpUngroupedJobsUseIndependentGroups(t *testing.T) {
	s := New(Config{})
	now := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	s.SetNowFn(func() time.Time { return now })
	morning := extension.ScheduleJob{JobID: "morning", Kind: extension.ScheduleDaily, Time: "09:00", CatchUp: "latest"}
	evening := extension.ScheduleJob{JobID: "evening", Kind: extension.ScheduleDaily, Time: "11:00", CatchUp: "latest"}

	s.queueLatestCatchUp(testHostWithSchedule(t, "ext", morning), morning, now.Add(-3*time.Hour), true)
	s.queueLatestCatchUp(testHostWithSchedule(t, "ext", evening), evening, now.Add(-time.Hour), true)

	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.latestCatchUp) != 2 {
		t.Fatalf("ungrouped latest jobs = %d groups, want 2", len(s.latestCatchUp))
	}
}

func TestLatestCatchUpSelectsNewestGroupMember(t *testing.T) {
	s := New(Config{})
	now := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	s.SetNowFn(func() time.Time { return now })
	morning := extension.ScheduleJob{JobID: "morning", Kind: extension.ScheduleDaily, Time: "09:00", CatchUp: "latest", CatchUpGroup: "briefings"}
	evening := extension.ScheduleJob{JobID: "evening", Kind: extension.ScheduleDaily, Time: "11:00", CatchUp: "latest", CatchUpGroup: "briefings"}
	morningHost := testHostWithSchedule(t, "ext", morning)
	eveningHost := testHostWithSchedule(t, "ext", evening)

	s.queueLatestCatchUp(morningHost, morning, time.Date(2026, 5, 25, 9, 0, 0, 0, time.UTC), true)
	s.queueLatestCatchUp(eveningHost, evening, time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC), true)

	s.mu.Lock()
	if len(s.latestCatchUp) != 1 {
		s.mu.Unlock()
		t.Fatalf("latest groups = %d, want 1", len(s.latestCatchUp))
	}
	for _, candidate := range s.latestCatchUp {
		if candidate.job.JobID != "evening" {
			s.mu.Unlock()
			t.Fatalf("selected %q, want newest evening job", candidate.job.JobID)
		}
	}
	s.mu.Unlock()
}

func TestLatestCatchUpSameDayRejectsOlderSlot(t *testing.T) {
	s := New(Config{})
	now := time.Date(2026, 5, 25, 10, 0, 0, 0, time.UTC)
	s.SetNowFn(func() time.Time { return now })
	job := extension.ScheduleJob{JobID: "brief", Kind: extension.ScheduleDaily, Time: "09:00", CatchUp: "latest", CatchUpScope: "same_day"}
	h := testHostWithSchedule(t, "ext", job)
	s.queueLatestCatchUp(h, job, now.Add(-24*time.Hour), true)

	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.latestCatchUp) != 0 {
		t.Fatalf("out-of-scope candidate retained: %+v", s.latestCatchUp)
	}
}
