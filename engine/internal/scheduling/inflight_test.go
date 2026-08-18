package scheduling

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// testClock is a manually-advanced clock for the in-flight watchdog tests.
// The watchdog is time-driven, so the tests must own time rather than sleep.
type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *testClock) get() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// TestScheduler_StalledFire_SlotReclaimed_JobRefires pins the defect that
// retired a schedule for 3h44m in production: a fire blocked in session
// resolution held its in-flight claim forever, so every later tick saw the
// job as busy and skipped it. Reverting reapInFlight makes the second fire
// never happen and this test fails on the refire assertion.
func TestScheduler_StalledFire_SlotReclaimed_JobRefires(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "stalled-job",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 1000,
	}
	h := testHostWithSchedule(t, "ion-dev", job)

	clock := &testClock{now: time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)}
	events := make(chan types.EngineEvent, 64)
	s := New(Config{FireTimeout: 5 * time.Second})
	s.SetEmit(func(ev types.EngineEvent) { events <- ev })
	s.nowFn = clock.get
	s.AddHost(h)

	// The resolver parks forever — the exact shape of the production stall,
	// where resolve blocked on the session manager's write lock.
	entered := make(chan struct{}, 4)
	unblock := make(chan struct{})
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		entered <- struct{}{}
		<-unblock
		return &extension.Context{SessionKey: "test"}, nil
	})
	defer close(unblock)

	s.tickOnce() // first sighting: bootstraps next-run, does not fire
	clock.advance(time.Duration(job.IntervalMs) * time.Millisecond)
	s.tickOnce() // due: dispatches the fire that will stall

	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("fire never reached the session resolver")
	}

	if _, held := s.inFlight.Load(s.fireKey(h, job)); !held {
		t.Fatal("expected the stalled fire to hold its in-flight claim")
	}

	// Still inside the stall deadline: the claim must survive, because an
	// overlapping fire is the thing the claim exists to prevent.
	clock.advance(time.Second)
	s.tickOnce()
	if _, held := s.inFlight.Load(s.fireKey(h, job)); !held {
		t.Fatal("claim reclaimed before the stall deadline elapsed")
	}

	// Past fireTimeout + StallGrace: the watchdog reclaims.
	clock.advance(5*time.Second + StallGrace)
	s.tickOnce()
	if _, held := s.inFlight.Load(s.fireKey(h, job)); held {
		t.Fatal("stalled claim was not reclaimed after the stall deadline")
	}

	var sawFailed bool
	for _, ev := range drainEvents(events) {
		if ev.Type == "engine_schedule_failed" && ev.AsyncID == job.JobID &&
			strings.Contains(ev.AsyncReason, "stalled") {
			sawFailed = true
		}
	}
	if !sawFailed {
		t.Fatal("expected engine_schedule_failed reporting the stalled fire")
	}

	// The job must be firable again. Without the reclaim it never is.
	clock.advance(time.Duration(job.IntervalMs) * time.Millisecond)
	s.tickOnce()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("job did not re-fire after its stalled claim was reclaimed")
	}
}

// TestScheduler_LateFireRelease_DoesNotEvictNewerClaim pins the reason
// release is a compare-and-delete: a stalled fire that finally returns must
// not drop the claim of the fire that replaced it, or the job would run
// twice concurrently — the exact overlap the claim prevents.
func TestScheduler_LateFireRelease_DoesNotEvictNewerClaim(t *testing.T) {
	job := extension.ScheduleJob{JobID: "late-return", Kind: extension.ScheduleInterval, IntervalMs: 1000}
	h := testHostWithSchedule(t, "ion-dev", job)

	clock := &testClock{now: time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)}
	s := New(Config{FireTimeout: 5 * time.Second})
	s.nowFn = clock.get
	s.AddHost(h)

	key := hostJobKey{host: h, id: job.JobID}
	stalled, busy := s.claimInFlight(key, job, clock.get())
	if busy {
		t.Fatal("first claim should not be busy")
	}

	// Watchdog reclaims the stalled fire's claim.
	clock.advance(5*time.Second + StallGrace)
	s.reapInFlight(clock.get(), map[hostJobKey]struct{}{key: {}})
	if _, held := s.inFlight.Load(key); held {
		t.Fatal("expected the stalled claim to be reclaimed")
	}

	// A fresh fire claims the slot.
	fresh, busy := s.claimInFlight(key, job, clock.get())
	if busy {
		t.Fatal("fresh claim should succeed after the reclaim")
	}

	// The stalled fire returns and releases. The fresh claim must survive.
	s.releaseInFlight(h, key, stalled)
	got, held := s.inFlight.Load(key)
	if !held {
		t.Fatal("late release evicted the newer claim")
	}
	if got != any(fresh) {
		t.Fatalf("in-flight map holds the wrong slot: %v", got)
	}
}

// TestScheduler_OrphanedClaim_Reclaimed covers the second leak in the same
// map: the claim key holds an *extension.Host pointer, so a claim for a job
// that has since been cancelled (or whose host was replaced) is unreleasable
// and pins the dead host for the life of the daemon.
func TestScheduler_OrphanedClaim_Reclaimed(t *testing.T) {
	job := extension.ScheduleJob{JobID: "orphan", Kind: extension.ScheduleInterval, IntervalMs: 1000}
	h := testHostWithSchedule(t, "ion-dev", job)

	clock := &testClock{now: time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)}
	s := New(Config{FireTimeout: time.Hour}) // long, so only the orphan rule can reclaim
	s.nowFn = clock.get

	key := hostJobKey{host: h, id: job.JobID}
	if _, busy := s.claimInFlight(key, job, clock.get()); busy {
		t.Fatal("claim should not be busy")
	}

	// Inside the grace window an unregistered job keeps its claim: the job
	// may simply be mid-deregistration while its handler still runs.
	s.reapInFlight(clock.get(), map[hostJobKey]struct{}{})
	if _, held := s.inFlight.Load(key); !held {
		t.Fatal("orphan reclaimed inside the grace window")
	}

	clock.advance(StallGrace)
	s.reapInFlight(clock.get(), map[hostJobKey]struct{}{})
	if _, held := s.inFlight.Load(key); held {
		t.Fatal("claim for an unregistered job was not reclaimed")
	}
}

// TestScheduler_SkipTicksCounted asserts the per-claim skip counter that
// throttles the skip log. Before the throttle a wedged job wrote one INFO
// line per tick — ~86k lines/day, which rotated real diagnostics out of the
// log file. The count is also the diagnostic: it says how many fires the
// stall swallowed.
func TestScheduler_SkipTicksCounted(t *testing.T) {
	job := extension.ScheduleJob{JobID: "skip-count", Kind: extension.ScheduleInterval, IntervalMs: 1000}
	h := testHostWithSchedule(t, "ion-dev", job)

	clock := &testClock{now: time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)}
	s := New(Config{})
	s.nowFn = clock.get

	key := hostJobKey{host: h, id: job.JobID}
	slot, _ := s.claimInFlight(key, job, clock.get())

	for i := 0; i < 3; i++ {
		held, busy := s.claimInFlight(key, job, clock.get())
		if !busy {
			t.Fatal("expected the claim to report busy")
		}
		clock.advance(time.Second)
		s.logSkippedTick(h, key, held, clock.get())
	}

	if got := slot.skips.Load(); got != 3 {
		t.Fatalf("skips = %d, want 3", got)
	}
}
