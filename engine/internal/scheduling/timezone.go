// Next-run computation, timezone resolution, and catch-up logic for
// the scheduler. Separated from scheduler.go so the tick-loop file
// focuses on dispatch and this file owns the time math.

package scheduling

import (
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// scheduleMissedDecision is returned by computeBootstrapNextRun when a
// missed slot is detected and a schedule_missed hook is registered. The
// caller is responsible for emitting the engine_schedule_missed event
// and firing the hook.
type scheduleMissedDecision struct {
	Slot      time.Time
	HadMarker bool
}

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

// Now is the exported wrapper for the test-injectable clock. Used by
// the session manager for time.Now() at the scheduler's resolution.
func (s *Scheduler) Now() time.Time {
	return s.now()
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
		utils.LogWithFields(utils.LevelWarn, "scheduling", "load tz unknown falling back to local", map[string]any{"reason": tz, "error": err.Error()})
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
	case extension.ScheduleOnce:
		return from.Add(time.Duration(job.DelayMs) * time.Millisecond)
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
// fire or emit a schedule_missed decision for extension-decided catch-up.
//
// Sibling-cadence inheritance (#285): when a host is replaced (session
// teardown + recreation), the new host is a "first sighting" despite the
// job having been firing on cadence via a sibling host. To avoid silently
// resetting the interval, bootstrapNextRun checks whether any surviving
// sibling host (same extensionJobKey) already has a nextRun entry, and
// if so adopts that value instead of computing a fresh now+interval. The
// inherit is only applied for interval jobs — daily/weekly jobs have
// wall-clock slots that don't depend on accumulated elapsed time, so they
// are handled correctly by the existing persistence-based catch-up path.
func (s *Scheduler) bootstrapNextRun(h *extension.Host, job extension.ScheduleJob, now time.Time) {
	name := hostName(h)
	loc := s.loadTz(jobTz(job))
	hasMissedHook := h != nil && h.HasScheduleMissedHandler()

	// Sibling-cadence inheritance for interval jobs: if a sibling host for the
	// same (extensionName, jobID) already has a nextRun entry, inherit it. This
	// preserves the firing cadence across session teardown+recreation (host
	// pointer replacement) without resetting the interval clock to now+interval.
	// Only applies to ScheduleInterval — daily/weekly schedule wall-clock slots
	// correctly and don't need this.
	if job.Kind == extension.ScheduleInterval {
		extKey := extensionJobKey{name: h.Name(), id: job.JobID}
		if sibling := s.siblingNextRun(extKey); !sibling.IsZero() {
			key := hostJobKey{host: h, id: job.JobID}
			s.mu.Lock()
			s.nextRun[key] = sibling
			s.extNextRun[extKey] = sibling
			s.mu.Unlock()
			utils.LogWithFields(utils.LevelDebug, "scheduling", "bootstrap next run inherited from sibling", map[string]any{
				"model": name, "run_id": job.JobID, "inherited": sibling.String(),
			})
			return
		}
	}

	next, decision := s.computeBootstrapNextRun(name, job, now, loc, hasMissedHook)
	key := hostJobKey{host: h, id: job.JobID}
	extKey := extensionJobKey{name: h.Name(), id: job.JobID}

	s.mu.Lock()
	s.nextRun[key] = next
	s.extNextRun[extKey] = next
	s.mu.Unlock()
	utils.LogWithFields(utils.LevelDebug, "scheduling", "bootstrap next run", map[string]any{"model": name, "run_id": job.JobID, "reason": next.String()})

	if decision != nil {
		// Emit the engine_schedule_missed event.
		s.emitScheduleMissed(job, decision.Slot, decision.HadMarker)
		// Fire the schedule_missed hook with a resolved ctx.
		s.mu.RLock()
		resolve := s.resolve
		s.mu.RUnlock()
		if resolve != nil && h != nil {
			go func() {
				ctx, err := resolve(h)
				if err != nil || ctx == nil {
					// resolve may return (nil, nil); guard so the error field is
					// a real reason and never a serialized null.
					errMsg := "nil context"
					if err != nil {
						errMsg = err.Error()
					}
					utils.LogWithFields(utils.LevelInfo, "scheduling", "bootstrap schedule missed hook resolve failed", map[string]any{"model": name, "run_id": job.JobID, "error": errMsg})
					return
				}
				info := extension.ScheduleMissedInfo{
					ID:             job.JobID,
					Kind:           string(job.Kind),
					MissedSlotUtc:  decision.Slot.UTC().Format(time.RFC3339),
					HadMarker:      decision.HadMarker,
					RanWithinScope: s.lastRunWithinScopeByName(name, job, now, loc),
				}
				h.FireScheduleMissed(ctx, info)
				utils.LogWithFields(utils.LevelInfo, "scheduling", "bootstrap schedule missed hook fired", map[string]any{"model": name, "run_id": job.JobID, "slot": info.MissedSlotUtc})
			}()
		}
	}
}

// computeBootstrapNextRun is the pure computation half of
// bootstrapNextRun, factored out so catchup_test.go can exercise the
// decision tree without needing a real *extension.Host.
//
// When hasMissedHook is true and a missed slot is detected, the method
// returns (normal next slot, non-nil decision) so the caller can emit
// the event and fire the hook. When hasMissedHook is false and a missed
// slot is detected, auto-catch-up fires (next = now + stagger).
//
// First-sighting flood guard: when no marker exists at all, the method
// records FirstSeenUtc and does NOT catch up on this pass. A job first
// seen at noon will not catch up this morning's slot.
func (s *Scheduler) computeBootstrapNextRun(name string, job extension.ScheduleJob, now time.Time, loc *time.Location, hasMissedHook bool) (time.Time, *scheduleMissedDecision) {
	next := nextRunFor(job, now, loc)

	// Catch-up is disabled when persistence is off or CatchUpEnabled is
	// explicitly false. In that case every kind uses the naive next-run.
	if !s.shouldCatchUp() {
		return next, nil
	}

	// Interval catch-up: resume the persisted cadence across restarts.
	// Without a marker the in-memory next-run reset to now+interval on
	// every start, so a job whose interval exceeds mean uptime never
	// fired. With a marker we compute the next fire from the last run;
	// if that moment already passed (job missed one or more intervals
	// across the restart) fire ~now, staggered. No marker (first run
	// ever) keeps the original now+interval semantics — no thundering
	// herd on a fresh install.
	if job.Kind == extension.ScheduleInterval {
		lastRun, ok := s.readLastRunByName(name, job)
		if !ok || job.IntervalMs <= 0 {
			return next, nil
		}
		nextFromLast := lastRun.Add(time.Duration(job.IntervalMs) * time.Millisecond)
		if nextFromLast.After(now) {
			// Not yet due — resume the original cadence.
			return nextFromLast, nil
		}
		// Overdue across the restart — catch up soon.
		utils.LogWithFields(utils.LevelInfo, "scheduling", "bootstrap interval catch-up scheduled", map[string]any{"model": name, "run_id": job.JobID, "lastRun": lastRun.Format(time.RFC3339)})
		return now.Add(CatchUpStagger), nil
	}

	// Once jobs auto-deregister after firing; no catch-up needed.
	if job.Kind == extension.ScheduleOnce {
		return next, nil
	}

	// Daily/weekly catch-up: uses FirstSeen flood guard and hasMissedHook
	// delegation. Disabled when persistence is off (handled above).
	marker, hadFile := s.readMarker(name, job)

	if !hadFile {
		// First sighting: record FirstSeenUtc and do NOT catch up.
		// The next restart with an elapsed slot will see the marker
		// and know the job predates the slot.
		s.recordFirstSeenByName(name, job, now)
		utils.LogWithFields(utils.LevelInfo, "scheduling", "bootstrap first sighting recorded", map[string]any{"model": name, "run_id": job.JobID})
		return next, nil
	}

	// Determine the anchor time: LastRunUtc if set, else FirstSeenUtc.
	var anchor time.Time
	if marker.LastRunUtc != "" {
		if t, err := time.Parse(time.RFC3339, marker.LastRunUtc); err == nil {
			anchor = t
		}
	}
	if anchor.IsZero() && marker.FirstSeenUtc != "" {
		if t, err := time.Parse(time.RFC3339, marker.FirstSeenUtc); err == nil {
			anchor = t
		}
	}
	if anchor.IsZero() {
		// Marker file exists but both timestamps are unparseable.
		// Treat as first sighting.
		return next, nil
	}

	lastSlot := lastScheduledSlotBefore(job, now, loc)
	if lastSlot.After(anchor) {
		// The most recent slot is after the anchor: missed.
		hadMarker := marker.LastRunUtc != ""
		if hasMissedHook {
			// Extension decides: schedule normal next, emit decision.
			utils.LogWithFields(utils.LevelInfo, "scheduling", "bootstrap missed slot deferred to hook", map[string]any{"model": name, "run_id": job.JobID, "reason": lastSlot.String()})
			return next, &scheduleMissedDecision{Slot: lastSlot, HadMarker: hadMarker}
		}
		// No hook: auto-catch-up (same opinion as before).
		next = now.Add(CatchUpStagger)
		utils.LogWithFields(utils.LevelInfo, "scheduling", "bootstrap next run catch-up scheduled", map[string]any{"model": name, "run_id": job.JobID, "reason": lastSlot.String()})
		return next, nil
	}
	return next, nil
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
	extKey := extensionJobKey{name: key.host.Name(), id: key.id}
	s.mu.Lock()
	s.nextRun[key] = next
	s.extNextRun[extKey] = next
	s.mu.Unlock()
	utils.LogWithFields(utils.LevelDebug, "scheduling", "advance next run", map[string]any{"model": key.host.Name(), "run_id": key.id, "reason": next.String()})
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
