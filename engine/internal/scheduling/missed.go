// Missed-slot policy and live suspend reconciliation.
package scheduling

import (
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

const missedSlotGrace = time.Minute

// handleOverdueSlot reconciles a daily or weekly slot that elapsed while this
// process was suspended. A slot still inside its wall-clock minute is a normal
// live fire; a later tick is a missed slot and follows the job's catch-up policy.
func (s *Scheduler) handleOverdueSlot(h *extension.Host, job extension.ScheduleJob, key hostJobKey, slot *inFlightSlot, due, now time.Time, resolve SessionResolver) bool {
	if (job.Kind != extension.ScheduleDaily && job.Kind != extension.ScheduleWeekly) || now.Sub(due) < missedSlotGrace {
		return false
	}

	policy := s.catchUpPolicy(job, h.HasScheduleMissedHandler())
	if policy == "none" {
		s.advanceNextRun(key, job, now)
		s.emitScheduleSkipped(job, "missed_disabled")
		utils.LogWithFields(utils.LevelInfo, "scheduling", "missed slot skipped by policy", map[string]any{"model": h.Name(), "schedule_job_id": job.JobID, "slot": due.UTC().Format(time.RFC3339)})
		s.releaseInFlightKey(h, s.fireKey(h, job), slot)
		return true
	}

	if policy == "manual" {
		s.advanceNextRun(key, job, now)
		_, hadMarker := s.readMarker(h.Name(), job)
		s.recordMissedSlot(h, job, due, hadMarker)
		s.releaseInFlightKey(h, s.fireKey(h, job), slot)
		return true
	}
	if resolve == nil {
		s.advanceNextRun(key, job, now)
		s.releaseInFlightKey(h, s.fireKey(h, job), slot)
		s.emitScheduleSkipped(job, "no_resolver")
		utils.LogWithFields(utils.LevelError, "scheduling", "missed slot auto-fire skipped: no resolver", map[string]any{"model": h.Name(), "schedule_job_id": job.JobID})
		return true
	}

	go s.fireJobWithMeta(h, job, key, slot, resolve, true, due.UTC().Format(time.RFC3339))
	return true
}

func (s *Scheduler) recordMissedSlot(h *extension.Host, job extension.ScheduleJob, slot time.Time, hadMarker bool) {
	key := extensionJobKey{name: h.Name(), id: job.JobID}
	s.mu.Lock()
	s.missedSlots[key] = slot
	s.mu.Unlock()
	s.emitScheduleMissed(job, slot, hadMarker)

	s.mu.RLock()
	resolve := s.resolve
	s.mu.RUnlock()
	if resolve == nil {
		utils.LogWithFields(utils.LevelError, "scheduling", "missed slot hook skipped: no resolver", map[string]any{"model": h.Name(), "schedule_job_id": job.JobID})
		return
	}
	go func() {
		ctx, err := resolve(h)
		if err != nil || ctx == nil {
			errMsg := "nil context"
			if err != nil {
				errMsg = err.Error()
			}
			utils.LogWithFields(utils.LevelError, "scheduling", "missed slot hook resolve failed", map[string]any{"model": h.Name(), "schedule_job_id": job.JobID, "error": errMsg})
			return
		}
		info := extension.ScheduleMissedInfo{ID: job.JobID, Kind: string(job.Kind), MissedSlotUtc: slot.UTC().Format(time.RFC3339), HadMarker: hadMarker, RanWithinScope: s.lastRunWithinScopeByName(h.Name(), job, s.now(), s.loadTz(jobTz(job)))}
		s.missedHookMu.Lock()
		h.FireScheduleMissed(ctx, info)
		s.missedHookMu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "scheduling", "missed slot hook fired", map[string]any{"model": h.Name(), "schedule_job_id": job.JobID, "slot": info.MissedSlotUtc})
	}()
}

func (s *Scheduler) catchUpPolicy(job extension.ScheduleJob, hasMissedHook bool) string {
	switch job.CatchUp {
	case "auto", "manual", "none":
		return job.CatchUp
	}
	if !s.shouldCatchUp() {
		return "none"
	}
	if hasMissedHook {
		return "manual"
	}
	return "auto"
}
