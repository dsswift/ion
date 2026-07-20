// Observability event emission for the scheduler. Mirrors the
// webhooks package's emission helpers — every fire/skip/fail emits a
// structured EngineEvent so consumers can render an audit log.

package scheduling

import (
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func (s *Scheduler) publish(ev types.EngineEvent) {
	s.mu.RLock()
	fn := s.emit
	s.mu.RUnlock()
	if fn != nil {
		fn(ev)
	} else {
		// Emitter not wired — every schedule observability event is dropped.
		// Log so a late-wired emitter (full schedule-event blackout) is visible.
		utils.LogWithFields(utils.LevelWarn, "scheduling", "schedule event dropped: emitter not wired", map[string]any{"status": ev.Type, "run_id": ev.AsyncID})
	}
}

func (s *Scheduler) emitScheduleFired(job extension.ScheduleJob, elapsed time.Duration) {
	s.publish(types.EngineEvent{
		Type:            "engine_schedule_fired",
		AsyncKind:       string(asyncreg.KindSchedule),
		AsyncID:         job.JobID,
		AsyncDurationMs: elapsed.Milliseconds(),
	})
}

func (s *Scheduler) emitScheduleSkipped(job extension.ScheduleJob, reason string) {
	s.publish(types.EngineEvent{
		Type:        "engine_schedule_skipped",
		AsyncKind:   string(asyncreg.KindSchedule),
		AsyncID:     job.JobID,
		AsyncReason: reason,
	})
}

func (s *Scheduler) emitScheduleFailed(job extension.ScheduleJob, reason string, elapsed time.Duration) {
	s.publish(types.EngineEvent{
		Type:            "engine_schedule_failed",
		AsyncKind:       string(asyncreg.KindSchedule),
		AsyncID:         job.JobID,
		AsyncReason:     reason,
		AsyncDurationMs: elapsed.Milliseconds(),
	})
}

func (s *Scheduler) emitScheduleDeregistered(job extension.ScheduleJob, reason string) {
	s.publish(types.EngineEvent{
		Type:        "engine_schedule_deregistered",
		AsyncKind:   string(asyncreg.KindSchedule),
		AsyncID:     job.JobID,
		AsyncReason: reason,
	})
}

func (s *Scheduler) emitScheduleMissed(job extension.ScheduleJob, missedSlotUtc time.Time, hadMarker bool) {
	s.publish(types.EngineEvent{
		Type:            "engine_schedule_missed",
		AsyncKind:       string(asyncreg.KindSchedule),
		AsyncID:         job.JobID,
		AsyncMissedSlot: missedSlotUtc.UTC().Format(time.RFC3339),
		AsyncHadMarker:  hadMarker,
	})
}

// emitScheduleUnhosted signals that the last alive host for a (extension,
// jobID) group was removed and the job will not fire until a new host
// re-registers it. Consumers can use this to alert on unexpected schedule gaps.
func (s *Scheduler) emitScheduleUnhosted(job extension.ScheduleJob) {
	s.publish(types.EngineEvent{
		Type:      "engine_schedule_unhosted",
		AsyncKind: string(asyncreg.KindSchedule),
		AsyncID:   job.JobID,
	})
}
