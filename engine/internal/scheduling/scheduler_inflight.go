package scheduling

import (
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// inFlightSkipState tracks repeated in-flight skip ticks for a single job so the
// scheduler can log a periodic summary instead of flooding INFO on every tick.
type inFlightSkipState struct {
	count int
	since time.Time
}

// inFlightSkipSummaryInterval controls how many consecutive skips elapse between
// INFO-level summary lines. Individual skips log at DEBUG.
const inFlightSkipSummaryInterval = 30

// logInFlightSkip records repeated in-flight skips compactly. The first skip
// establishes an observable overlap; later INFO summaries arrive only at the
// configured interval, while DEBUG retains per-tick detail for diagnosis.
func (s *Scheduler) logInFlightSkip(h *extension.Host, job extension.ScheduleJob, key hostJobKey) {
	now := s.now()
	raw, _ := s.inFlightSkips.LoadOrStore(key, &inFlightSkipState{count: 0, since: now})
	state, ok := raw.(*inFlightSkipState)
	if !ok {
		utils.LogWithFields(utils.LevelError, "scheduling", "in-flight skip state had unexpected type", map[string]any{
			"model": h.Name(), "schedule_job_id": job.JobID,
		})
		return
	}
	state.count++

	fields := map[string]any{
		"model":           h.Name(),
		"schedule_job_id": job.JobID,
		"skips":           state.count,
		"in_flight_sec":   int(now.Sub(state.since).Seconds()),
	}
	if state.count == 1 || state.count%inFlightSkipSummaryInterval == 0 {
		utils.LogWithFields(utils.LevelInfo, "scheduling", "in-flight skip summary", fields)
		return
	}
	utils.LogWithFields(utils.LevelDebug, "scheduling", "in-flight skip", fields)
}
