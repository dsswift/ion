// Next-run computation, timezone resolution, and catch-up logic for
// the scheduler. Separated from scheduler.go so the tick-loop file
// focuses on dispatch and this file owns the time math.

package scheduling

import (
	"fmt"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// now returns the current time. Honors the test-injectable clock when
// set via SetNowFn.
func (s *Scheduler) now() time.Time {
	s.mu.RLock()
	fn := s.nowFn
	s.mu.RUnlock()
	if fn != nil {
		return fn()
	}
	return time.Now()
}

// SetNowFn injects a clock for deterministic tests. nil restores the
// real time.Now.
func (s *Scheduler) SetNowFn(fn func() time.Time) {
	s.mu.Lock()
	s.nowFn = fn
	s.mu.Unlock()
}

// defaultTz returns the Config's DefaultTz or "Local" when empty.
func (s *Scheduler) defaultTz() string {
	if s.cfg.DefaultTz != "" {
		return s.cfg.DefaultTz
	}
	return "Local"
}

// fireTimeout returns the configured default fire timeout.
func (s *Scheduler) fireTimeout() time.Duration {
	if s.cfg.FireTimeout > 0 {
		return s.cfg.FireTimeout
	}
	return DefaultFireTimeout
}

// fireTimeoutForJob resolves the per-job timeout: job override → config
// default → built-in DefaultFireTimeout.
func (s *Scheduler) fireTimeoutForJob(job extension.ScheduleJob) time.Duration {
	if job.TimeoutMs > 0 {
		return time.Duration(job.TimeoutMs) * time.Millisecond
	}
	return s.fireTimeout()
}

// loadTz returns the *time.Location for the job's Tz, falling back to
// the config default. Unknown timezones log a Warn and fall back to
// the system Local so a typo doesn't silently never-fire.
func (s *Scheduler) loadTz(tz string) *time.Location {
	if tz == "" {
		tz = s.defaultTz()
	}
	if tz == "Local" || tz == "" {
		return time.Local
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		utils.Warn("scheduler", fmt.Sprintf("loadTz: unknown tz %q, falling back to Local (%v)", tz, err))
		return time.Local
	}
	return loc
}

// nextRunFor computes when the job should next fire, given a reference
// time `from`. The returned time is in UTC for the in-memory map but
// the underlying math respects the job's configured timezone.
//
// For daily/weekly: pick the next wall-clock match at or after `from`.
// If `from` is before today's slot, return today's slot; otherwise
// roll forward to the next day / week.
//
// For interval: return `from + IntervalMs` exactly.
func nextRunFor(job extension.ScheduleJob, from time.Time, loc *time.Location) time.Time {
	switch job.Kind {
	case extension.ScheduleInterval:
		return from.Add(time.Duration(job.IntervalMs) * time.Millisecond)
	case extension.ScheduleDaily:
		hour, minute, ok := parseHHMM(job.Time)
		if !ok {
			// Validate() should have caught this; defensive fallback.
			return from.Add(24 * time.Hour)
		}
		fromLocal := from.In(loc)
		candidate := time.Date(fromLocal.Year(), fromLocal.Month(), fromLocal.Day(), hour, minute, 0, 0, loc)
		if !candidate.After(fromLocal) {
			candidate = candidate.Add(24 * time.Hour)
		}
		return candidate.UTC()
	case extension.ScheduleWeekly:
		hour, minute, ok := parseHHMM(job.Time)
		if !ok {
			return from.Add(7 * 24 * time.Hour)
		}
		target := weekdayFromName(job.DayOfWeek)
		fromLocal := from.In(loc)
		// Build today's candidate at the target time first; then
		// advance forward until weekday matches and time is strictly
		// after `from`.
		candidate := time.Date(fromLocal.Year(), fromLocal.Month(), fromLocal.Day(), hour, minute, 0, 0, loc)
		// Advance day-by-day until weekday matches; if matching weekday
		// is "today" but time already passed, advance 7 days from
		// today's candidate.
		for candidate.Weekday() != target || !candidate.After(fromLocal) {
			candidate = candidate.Add(24 * time.Hour)
		}
		return candidate.UTC()
	default:
		return from.Add(24 * time.Hour)
	}
}

// parseHHMM is a tiny parser for the validated HH:MM format. Returns
// hour, minute, ok. Validate() at registration time guarantees this
// returns ok=true for any job that reaches the scheduler.
func parseHHMM(s string) (int, int, bool) {
	if len(s) != 5 || s[2] != ':' {
		return 0, 0, false
	}
	h := int(s[0]-'0')*10 + int(s[1]-'0')
	m := int(s[3]-'0')*10 + int(s[4]-'0')
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, 0, false
	}
	return h, m, true
}

// weekdayFromName maps the lowercased English weekday name to
// time.Weekday. Returns Sunday for unknown inputs — Validate()
// guarantees recognised inputs at registration time.
func weekdayFromName(s string) time.Weekday {
	switch strings.ToLower(s) {
	case "monday":
		return time.Monday
	case "tuesday":
		return time.Tuesday
	case "wednesday":
		return time.Wednesday
	case "thursday":
		return time.Thursday
	case "friday":
		return time.Friday
	case "saturday":
		return time.Saturday
	case "sunday":
		return time.Sunday
	}
	return time.Sunday
}

// bootstrapNextRun computes the first next-run for a freshly-observed
// job. For daily/weekly with persistence enabled and CatchUpEnabled,
// reads the last-run marker and decides whether to schedule a catch-up
// fire (next-run = now + stagger) when the job's last scheduled slot
// has been missed.
func (s *Scheduler) bootstrapNextRun(h *extension.Host, job extension.ScheduleJob, now time.Time) {
	name := hostName(h)
	loc := s.loadTz(jobTz(job))
	next := s.computeBootstrapNextRun(name, job, now, loc)
	key := hostJobKey{host: h, id: job.JobID}

	s.mu.Lock()
	s.nextRun[key] = next
	s.mu.Unlock()
	utils.Debug("scheduler", fmt.Sprintf("bootstrapNextRun: ext=%s id=%q next=%s", name, job.JobID, next))
}

// computeBootstrapNextRun is the pure computation half of
// bootstrapNextRun, factored out so catchup_test.go can exercise the
// decision tree without needing a real *extension.Host. Same body
// as the inline logic — kept as a method on Scheduler so it has
// access to s.shouldCatchUp() and s.readLastRunByName.
func (s *Scheduler) computeBootstrapNextRun(name string, job extension.ScheduleJob, now time.Time, loc *time.Location) time.Time {
	next := nextRunFor(job, now, loc)

	// Catch-up only applies to daily/weekly (interval jobs catch up
	// implicitly by firing at now+interval). Disabled when persistence
	// is off or CatchUpEnabled is explicitly false.
	if job.Kind != extension.ScheduleInterval && s.shouldCatchUp() {
		if lastRun, ok := s.readLastRunByName(name, job); ok {
			// What was the most recent scheduled slot BEFORE now?
			lastSlot := lastScheduledSlotBefore(job, now, loc)
			// If lastSlot is after lastRun, the slot was missed.
			if lastSlot.After(lastRun) {
				// Schedule the catch-up fire ~now + stagger.
				next = now.Add(CatchUpStagger)
				utils.Log("scheduler", fmt.Sprintf("bootstrapNextRun: ext=%s id=%q catch-up scheduled (missed slot %s)", name, job.JobID, lastSlot))
			}
		}
	}
	return next
}

// jobTz returns the job's configured timezone or empty for default.
func jobTz(job extension.ScheduleJob) string { return job.Tz }

// shouldCatchUp reads the Config catch-up toggle.
func (s *Scheduler) shouldCatchUp() bool {
	if s.cfg.CatchUpEnabled == nil {
		return true
	}
	return *s.cfg.CatchUpEnabled
}

// advanceNextRun computes the post-fire next-run and stores it.
func (s *Scheduler) advanceNextRun(key hostJobKey, job extension.ScheduleJob, now time.Time) {
	loc := s.loadTz(jobTz(job))
	next := nextRunFor(job, now, loc)
	s.mu.Lock()
	s.nextRun[key] = next
	s.mu.Unlock()
	utils.Debug("scheduler", fmt.Sprintf("advanceNextRun: ext=%s id=%q next=%s", key.host.Name(), key.id, next))
}

// lastScheduledSlotBefore returns the most recent scheduled slot
// strictly before `before` for daily/weekly jobs. Used by the
// catch-up logic to compare against the persisted last-run marker.
func lastScheduledSlotBefore(job extension.ScheduleJob, before time.Time, loc *time.Location) time.Time {
	hour, minute, ok := parseHHMM(job.Time)
	if !ok {
		return time.Time{}
	}
	beforeLocal := before.In(loc)
	switch job.Kind {
	case extension.ScheduleDaily:
		// Today's slot if it's already passed; otherwise yesterday's.
		todaySlot := time.Date(beforeLocal.Year(), beforeLocal.Month(), beforeLocal.Day(), hour, minute, 0, 0, loc)
		if todaySlot.Before(beforeLocal) {
			return todaySlot.UTC()
		}
		return todaySlot.Add(-24 * time.Hour).UTC()
	case extension.ScheduleWeekly:
		target := weekdayFromName(job.DayOfWeek)
		// Walk backwards from today until the weekday matches and the
		// time is ≤ beforeLocal.
		candidate := time.Date(beforeLocal.Year(), beforeLocal.Month(), beforeLocal.Day(), hour, minute, 0, 0, loc)
		for candidate.Weekday() != target || candidate.After(beforeLocal) {
			candidate = candidate.Add(-24 * time.Hour)
		}
		return candidate.UTC()
	}
	return time.Time{}
}
