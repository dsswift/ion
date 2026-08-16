// In-flight arbitration for schedule fires.
//
// A fire claims the (host, jobID) slot before dispatching and releases it
// when the fire goroutine returns. The claim exists so two fires of the
// same job never overlap. It must therefore be impossible for a claim to
// outlive the fire that made it: a claim that is never released silently
// retires the job, because every later tick sees the slot as busy and
// skips. That is not hypothetical — a fire blocked in session resolution
// held one claim for 3h44m and the job never fired again until the owning
// extension host was replaced.
//
// Two mechanisms keep the claim honest:
//
//   - The slot pointer is the claim ticket. Release is a compare-and-delete
//     against the exact pointer stored at claim time, so a stalled fire that
//     resumes after the watchdog reclaimed its slot cannot evict the claim of
//     the fire that replaced it.
//   - reapInFlight is the watchdog. A claim older than the job's fire timeout
//     plus StallGrace is reclaimed and reported as a failed fire, which lets
//     the next tick re-fire the job even though the stalled goroutine is still
//     parked somewhere downstream.
package scheduling

import (
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// StallGrace is the slack added to a job's fire timeout before the
// watchdog reclaims its in-flight slot. FireAsync enforces its own
// timeout, so a fire that outlives timeout+grace is blocked somewhere
// the timeout does not cover (session resolution, the emit chain) and
// has no other bound.
const StallGrace = 30 * time.Second

// skipLogEvery throttles the per-tick "still in flight" line. The tick
// loop runs at 1Hz, so an unbounded log wrote ~86k lines/day for a
// single stuck job and buried every other diagnostic in the file. The
// first skip of each claim always logs; after that, one line per minute.
const skipLogEvery = 60

// inFlightSlot is one fire's claim on a (host, jobID) pair. Stored by
// pointer: identity is what makes release safe against a stalled fire
// whose claim was already reclaimed.
type inFlightSlot struct {
	started time.Time
	job     extension.ScheduleJob
	key     hostJobKey
	// skips counts ticks that found this claim busy. Atomic because the
	// tick loop reads/increments it while the fire goroutine runs.
	skips atomic.Int64
	// reclaimed is set by the watchdog so the owning fire can log that its
	// claim was already taken away when it eventually returns.
	reclaimed atomic.Bool
}

// claimInFlight attempts to take the slot for key. Returns the caller's
// own slot and false when the claim succeeded, or the existing holder's
// slot and true when a fire is already in flight.
func (s *Scheduler) claimInFlight(key hostJobKey, job extension.ScheduleJob, now time.Time) (*inFlightSlot, bool) {
	return s.claimInFlightKey(key, job, now, key)
}

func (s *Scheduler) claimInFlightKey(key any, job extension.ScheduleJob, now time.Time, activeKey hostJobKey) (*inFlightSlot, bool) {
	mine := &inFlightSlot{started: now, job: job, key: activeKey}
	if existing, loaded := s.inFlight.LoadOrStore(key, mine); loaded {
		held, ok := existing.(*inFlightSlot)
		if !ok {
			// Not reachable: only *inFlightSlot is ever stored. Log rather
			// than assert so a future writer of this map cannot make the
			// scheduler silently stop arbitrating.
			utils.LogWithFields(utils.LevelError, "scheduling", "in-flight slot has unexpected type; treating job as busy", map[string]any{
				"schedule_job_id": activeKey.id,
			})
			return nil, true
		}
		return held, true
	}
	return mine, false
}

// releaseInFlight drops the claim only when slot is still the stored
// holder. A stalled fire whose claim the watchdog already reclaimed
// therefore cannot delete a newer fire's claim.
func (s *Scheduler) releaseInFlight(h *extension.Host, key hostJobKey, slot *inFlightSlot) {
	s.releaseInFlightKey(h, key, slot)
}

func (s *Scheduler) releaseInFlightKey(h *extension.Host, key any, slot *inFlightSlot) {
	if slot == nil {
		return
	}
	if s.inFlight.CompareAndDelete(key, slot) {
		return
	}
	// Claim already gone: the watchdog reclaimed it. Report the late
	// return so the stall's true duration is in the log.
	if slot.reclaimed.Load() {
		utils.LogWithFields(utils.LevelWarn, "scheduling", "stalled fire returned after its slot was reclaimed", map[string]any{
			"model": hostName(h), "schedule_job_id": slot.key.id, "duration_ms": s.now().Sub(slot.started).Milliseconds(),
		})
	}
}

// logSkippedTick reports a tick that found the job already in flight,
// throttled to the first skip plus one line per minute. The elapsed
// time is the diagnostic that matters: a 2s overlap is normal, a
// 2000s one means the fire is wedged.
func (s *Scheduler) logSkippedTick(h *extension.Host, key hostJobKey, slot *inFlightSlot, now time.Time) {
	if slot == nil {
		return
	}
	n := slot.skips.Add(1)
	if n != 1 && n%skipLogEvery != 0 {
		return
	}
	utils.LogWithFields(utils.LevelInfo, "scheduling", "maybe fire skip previous in flight", map[string]any{
		"model": hostName(h), "schedule_job_id": key.id, "run_id": key.id,
		"count": n, "duration_ms": now.Sub(slot.started).Milliseconds(),
	})
}

// reapInFlight reclaims claims that can no longer belong to a live fire.
// Called once per tick with the tick's active-key view.
//
// Two cases are reclaimed:
//
//   - Stalled: the claim is older than the job's fire timeout plus
//     StallGrace. The fire is blocked past every bound it has, so the
//     claim is reported as a failed fire and dropped; the next due tick
//     re-fires the job.
//   - Orphaned: the key names a (host, job) pair that is no longer
//     registered — the job was cancelled or the host was replaced — and
//     the claim is past the grace window. Nothing can ever release it,
//     and the key pins the dead *extension.Host in the map.
func (s *Scheduler) reapInFlight(now time.Time, activeKeys map[hostJobKey]struct{}) {
	s.inFlight.Range(func(k, v any) bool {
		slot, ok := v.(*inFlightSlot)
		if !ok {
			return true
		}
		elapsed := now.Sub(slot.started)
		_, active := activeKeys[slot.key]
		deadline := s.fireTimeoutForJob(slot.job) + StallGrace
		switch {
		case elapsed >= deadline:
			if !s.inFlight.CompareAndDelete(k, slot) {
				return true // released concurrently; nothing to reclaim.
			}
			slot.reclaimed.Store(true)
			utils.LogWithFields(utils.LevelError, "scheduling", "reclaiming in-flight slot: fire exceeded stall deadline", map[string]any{
				"schedule_job_id": slot.key.id, "duration_ms": elapsed.Milliseconds(),
				"max": deadline.Milliseconds(), "count": slot.skips.Load(), "reason": "stalled",
			})
			s.emitScheduleFailed(slot.job, "fire stalled: in-flight slot reclaimed", elapsed)
		case !active && elapsed >= StallGrace:
			if !s.inFlight.CompareAndDelete(k, slot) {
				return true
			}
			slot.reclaimed.Store(true)
			utils.LogWithFields(utils.LevelWarn, "scheduling", "reclaiming in-flight slot: job no longer registered", map[string]any{
				"schedule_job_id": slot.key.id, "duration_ms": elapsed.Milliseconds(), "reason": "orphaned",
			})
		}
		return true
	})
}
