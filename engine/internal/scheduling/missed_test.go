package scheduling

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestHandleOverdueSlot_NoResolverAdvancesCadenceAndPreservesNewClaim(t *testing.T) {
	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC)
	job := extension.ScheduleJob{JobID: "overdue-auto", Kind: extension.ScheduleDaily, Time: "09:00", Tz: "UTC"}
	host := testHostWithSchedule(t, "ion-dev", job)
	s := New(Config{})
	s.SetNowFn(func() time.Time { return now })
	s.AddHost(host)

	activeKey := hostJobKey{host: host, id: job.JobID}
	fireKey := s.fireKey(host, job)
	stale, busy := s.claimInFlightKey(fireKey, job, now, activeKey)
	if busy {
		t.Fatal("precondition: stale slot claim failed")
	}
	if !s.inFlight.CompareAndDelete(fireKey, stale) {
		t.Fatal("precondition: could not reclaim stale slot")
	}
	replacement, busy := s.claimInFlightKey(fireKey, job, now, activeKey)
	if busy {
		t.Fatal("precondition: replacement slot claim failed")
	}

	if !s.handleOverdueSlot(host, job, activeKey, stale, now.Add(-2*time.Minute), now, nil) {
		t.Fatal("overdue daily slot was not handled")
	}
	if holder, ok := s.inFlight.Load(fireKey); !ok || holder != replacement {
		t.Fatal("stale no-resolver path removed replacement in-flight claim")
	}

	s.mu.RLock()
	next := s.nextRun[activeKey]
	s.mu.RUnlock()
	wantNext := time.Date(2026, 5, 26, 9, 0, 0, 0, time.UTC)
	if !next.Equal(wantNext) {
		t.Fatalf("nextRun=%v, want %v; overdue no-resolver path must advance cadence", next, wantNext)
	}
}

func TestHandleOverdueSlot_ManualReportsActualMarkerPresence(t *testing.T) {
	now := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC)
	job := extension.ScheduleJob{
		JobID: "overdue-manual", Kind: extension.ScheduleDaily, Time: "09:00", Tz: "UTC", CatchUp: "manual",
	}
	host := testHostWithSchedule(t, "ion-dev", job)
	events := make(chan types.EngineEvent, 1)
	s := New(Config{PersistDir: t.TempDir()})
	s.SetNowFn(func() time.Time { return now })
	s.SetEmit(func(event types.EngineEvent) { events <- event })
	s.AddHost(host)

	activeKey := hostJobKey{host: host, id: job.JobID}
	slot, busy := s.claimInFlightKey(s.fireKey(host, job), job, now, activeKey)
	if busy {
		t.Fatal("precondition: manual slot claim failed")
	}
	if !s.handleOverdueSlot(host, job, activeKey, slot, now.Add(-2*time.Minute), now, nil) {
		t.Fatal("overdue manual slot was not handled")
	}

	select {
	case event := <-events:
		if event.Type != "engine_schedule_missed" || event.AsyncHadMarker {
			t.Fatalf("event=%+v, want missed event with asyncHadMarker=false", event)
		}
	default:
		t.Fatal("manual overdue slot did not emit engine_schedule_missed")
	}
}
