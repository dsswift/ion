// Schedule fire execution and immediate-fire entry points.
package scheduling

import (
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// FireScheduleNow triggers an immediate fire of the named job on host h.
// Honors in-flight + single-concurrency arbitration. Returns nil on success,
// nil when the job is already in-flight (benign), or an error when the job
// is not found or no resolver is wired.
func (s *Scheduler) FireScheduleNow(h *extension.Host, jobID string) error {
	if h == nil {
		return fmt.Errorf("fire schedule now: nil host")
	}
	// Locate the job declaration on host h's AsyncRegistry.
	decl, found := h.AsyncRegistry().ByID(asyncreg.KindSchedule, jobID)
	if !found {
		return fmt.Errorf("fire schedule now: job %q not found on host %s", jobID, h.Name())
	}
	job, ok := decl.(extension.ScheduleJob)
	if !ok {
		return fmt.Errorf("fire schedule now: job %q has unexpected type", jobID)
	}

	// Determine the target host for concurrency coordination.
	var target *extension.Host
	if job.Concurrency == "all" {
		target = h
	} else {
		// Single (default): first non-dead host that owns this job.
		s.mu.RLock()
		hosts := append([]*extension.Host(nil), s.hosts...)
		s.mu.RUnlock()
		for _, candidate := range hosts {
			if candidate.Dead() || candidate.Name() != h.Name() {
				continue
			}
			if _, found := candidate.AsyncRegistry().ByID(asyncreg.KindSchedule, jobID); found {
				target = candidate
				break
			}
		}
		if target == nil {
			target = h // fallback
		}
	}

	key := hostJobKey{host: target, id: jobID}
	slot, busy := s.claimInFlightKey(s.fireKey(target, job), job, s.now(), key)
	if busy {
		// Already in-flight: benign, not an error.
		utils.LogWithFields(utils.LevelInfo, "scheduling", "fire schedule now skipped already in flight", map[string]any{"model": target.Name(), "schedule_job_id": jobID})
		return nil
	}

	s.mu.RLock()
	resolve := s.resolve
	s.mu.RUnlock()
	if resolve == nil {
		s.releaseInFlightKey(target, s.fireKey(target, job), slot)
		return fmt.Errorf("fire schedule now: no resolver wired")
	}

	missedSlot := s.takeMissedSlot(target, job)
	go s.fireJobWithMeta(target, job, key, slot, resolve, true, missedSlot)
	return nil
}

// fireJobWithMeta is like fireJob but carries optional backfill metadata
// in the payload so the handler can distinguish a manual/backfill fire from
// a live tick fire. When backfill is false, behavior is identical to fireJob.
func (s *Scheduler) fireJobWithMeta(h *extension.Host, job extension.ScheduleJob, key hostJobKey, slot *inFlightSlot, resolve SessionResolver, backfill bool, missedSlotUtc string) {
	defer s.releaseInFlightKey(h, s.fireKey(h, job), slot)
	now := s.now()

	if job.Kind != extension.ScheduleOnce {
		s.advanceNextRun(key, job, now)
	}

	ctx, err := resolve(h)
	if err != nil || ctx == nil {
		s.emitScheduleSkipped(job, "no_session")
		errMsg := "nil context"
		if err != nil {
			errMsg = err.Error()
		}
		utils.LogWithFields(utils.LevelInfo, "scheduling", "fire job with meta session resolve failed", map[string]any{"model": h.Name(), "schedule_job_id": job.JobID, "error": errMsg})
		return
	}

	if job.EnabledRefName != "" {
		enabled, err := s.resolveEnabledPredicate(h, job)
		if err != nil {
			s.emitScheduleSkipped(job, "predicate_error")
			utils.LogWithFields(utils.LevelError, "scheduling", "fire job with meta predicate failed", map[string]any{"model": h.Name(), "schedule_job_id": job.JobID, "error": err.Error()})
			return
		}
		if !enabled {
			s.emitScheduleSkipped(job, "disabled")
			return
		}
	}

	timeout := s.fireTimeoutForJob(job)
	utils.LogWithFields(utils.LevelInfo, "scheduling", "fire job with meta", map[string]any{"model": h.Name(), "schedule_job_id": job.JobID, "backfill": backfill})
	startTs := s.now()
	payload := map[string]interface{}{
		"firedAt": startTs.UTC().Format(time.RFC3339),
	}
	if backfill {
		payload["backfill"] = true
		if missedSlotUtc != "" {
			payload["missedSlotUtc"] = missedSlotUtc
		}
	}
	_, err = h.FireAsync(asyncreg.KindSchedule, job.JobID, ctx, payload, timeout)
	elapsed := s.now().Sub(startTs)
	if err != nil {
		s.emitScheduleFailed(job, err.Error(), elapsed)
		utils.LogWithFields(utils.LevelError, "scheduling", "fire job with meta handler error", map[string]any{"model": h.Name(), "schedule_job_id": job.JobID, "error": err.Error(), "duration_ms": elapsed.Milliseconds()})
	} else {
		s.recordLastRun(h, job, startTs)
		s.emitScheduleFired(job, elapsed)
		utils.LogWithFields(utils.LevelInfo, "scheduling", "fire job with meta completed", map[string]any{"model": h.Name(), "schedule_job_id": job.JobID, "duration_ms": elapsed.Milliseconds()})
	}

	if job.Kind == extension.ScheduleOnce {
		ok := h.DeregisterScheduleDeclSilent(job.JobID)
		if ok {
			s.mu.Lock()
			delete(s.nextRun, key)
			// Spent shot: drop the logical-identity cadence entry too (see
			// the mirror comment in fireJob's once-deregister block).
			delete(s.extNextRun, extensionJobKey{name: h.Name(), id: job.JobID})
			s.mu.Unlock()
			s.emitScheduleDeregistered(job, "once_complete")
		}
	}
}

func (s *Scheduler) fireKey(h *extension.Host, job extension.ScheduleJob) any {
	if job.Concurrency == "all" {
		return hostJobKey{host: h, id: job.JobID}
	}
	return extensionJobKey{name: h.Name(), id: job.JobID}
}

func (s *Scheduler) takeMissedSlot(h *extension.Host, job extension.ScheduleJob) string {
	key := extensionJobKey{name: h.Name(), id: job.JobID}
	s.mu.Lock()
	slot := s.missedSlots[key]
	delete(s.missedSlots, key)
	s.mu.Unlock()
	if slot.IsZero() {
		return ""
	}
	return slot.UTC().Format(time.RFC3339)
}
