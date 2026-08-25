package scheduling

import (
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
)

// dailyMatches reports whether a daily job is allowed to run on localDay.
// An empty filter preserves the historic every-day behavior.
func dailyMatches(job extension.ScheduleJob, localDay time.Time) bool {
	if len(job.DaysOfWeek) == 0 {
		return true
	}
	for _, day := range job.DaysOfWeek {
		if weekdayFromName(day) == localDay.Weekday() {
			return true
		}
	}
	return false
}

func nextDailyRunFor(job extension.ScheduleJob, from time.Time, loc *time.Location) time.Time {
	hour, minute, ok := parseHHMM(job.Time)
	if !ok {
		return from.Add(24 * time.Hour)
	}
	local := from.In(loc)
	for day := local; ; day = day.AddDate(0, 0, 1) {
		candidate := time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, loc)
		if dailyMatches(job, candidate) && candidate.After(local) {
			return candidate.UTC()
		}
	}
}

func lastDailySlotBefore(job extension.ScheduleJob, before time.Time, loc *time.Location) time.Time {
	hour, minute, ok := parseHHMM(job.Time)
	if !ok {
		return time.Time{}
	}
	local := before.In(loc)
	for day := local; ; day = day.AddDate(0, 0, -1) {
		candidate := time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, loc)
		if dailyMatches(job, candidate) && candidate.Before(local) {
			return candidate.UTC()
		}
	}
}
