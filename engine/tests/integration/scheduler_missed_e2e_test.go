//go:build integration

package integration

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/scheduling"
	"github.com/dsswift/ion/engine/internal/types"
)

const (
	missedEarlyID = "async-canary-missed-early"
	missedLateID  = "async-canary-missed-late"
)

type missedCanaryHarness struct {
	host *extension.Host
	sch  *scheduling.Scheduler
	bus  *eventBus
	now  *time.Time
}

func newMissedCanaryHarness(t *testing.T, persistDir string, now time.Time) *missedCanaryHarness {
	t.Helper()
	requireEsbuild(t)
	host := extension.NewHost()
	t.Cleanup(host.Dispose)
	entry := asyncCanaryEntry(t)
	if err := host.Load(entry, &extension.ExtensionConfig{ExtensionDir: filepath.Dir(entry), WorkingDirectory: t.TempDir()}); err != nil {
		t.Fatalf("load canary: %v", err)
	}
	if errs := host.CommitPendingAsyncDecls(); len(errs) != 0 {
		t.Fatalf("commit canary schedules: %v", errs)
	}
	// The interval fixture exercises other scheduler tests but would create
	// unrelated concurrent FireAsync traffic during this missed-slot harness.
	if !host.DeregisterScheduleDecl("async-canary-tick") {
		t.Fatal("missing async-canary-tick fixture")
	}

	clock := now
	bus := &eventBus{}
	sch := scheduling.New(scheduling.Config{PersistDir: persistDir, FireTimeout: time.Second})
	sch.SetNowFn(func() time.Time { return clock })
	sch.SetEmit(bus.emit)
	sch.SetSessionResolver(func(*extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "missed-canary"}, nil
	})
	sch.AddHost(host)
	host.SetPersistentScheduleControl(func(jobID string) error { return sch.FireScheduleNow(host, jobID) }, nil)
	host.SetPersistentEmit(func(ev types.EngineEvent) {
		if ev.Type == "async_canary_missed_probe" || ev.Type == "async_canary_missed_result" {
			bus.emit(ev)
		}
	})
	return &missedCanaryHarness{host: host, sch: sch, bus: bus, now: &clock}
}

func (h *missedCanaryHarness) tick() { h.sch.TickOnceForTest() }

func waitForCanaryEvents(t *testing.T, bus *eventBus, want int) []types.EngineEvent {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var out []types.EngineEvent
		for _, ev := range bus.snapshot() {
			if ev.Type == "async_canary_missed_probe" || ev.Type == "async_canary_missed_result" {
				out = append(out, ev)
			}
		}
		if len(out) >= want {
			return out
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil
}

func assertLatestCanaryOnly(t *testing.T, bus *eventBus, events []types.EngineEvent) {
	t.Helper()
	var selected, result int
	var earlyMissed, lateMissed bool
	for _, ev := range bus.ofType("engine_schedule_missed") {
		if ev.AsyncID == missedEarlyID && ev.AsyncMissedSlot == "2026-05-25T09:00:00Z" {
			earlyMissed = true
		}
		if ev.AsyncID == missedLateID && ev.AsyncMissedSlot == "2026-05-25T10:00:00Z" {
			lateMissed = true
		}
	}
	if !earlyMissed || !lateMissed {
		t.Fatalf("missed events early=%t late=%t all=%+v", earlyMissed, lateMissed, bus.snapshot())
	}
	for _, ev := range events {
		id, _ := ev.Metadata["id"].(string)
		slot, _ := ev.Metadata["missedSlotUtc"].(string)
		switch ev.EventMessage {
		case "selected":
			selected++
			if id != missedLateID || slot != "2026-05-25T10:00:00Z" {
				t.Fatalf("winner=%+v", ev)
			}
		case "handler fired":
			result++
			backfill, _ := ev.Metadata["backfill"].(string)
			if id != missedLateID || backfill != "true" || slot != "2026-05-25T10:00:00Z" {
				t.Fatalf("handler=%+v", ev)
			}
		}
	}
	if selected != 1 || result != 1 {
		t.Fatalf("events selected=%d result=%d all=%+v", selected, result, events)
	}
}

func TestSchedulerMissedCanary_RestartSelectsLatest(t *testing.T) {
	persistDir := t.TempDir()
	before := time.Date(2026, 5, 25, 8, 0, 0, 0, time.UTC)
	first := newMissedCanaryHarness(t, persistDir, before)
	first.tick() // First sighting persists anchors before either daily slot.

	after := time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC)
	second := newMissedCanaryHarness(t, persistDir, after)
	second.tick()
	events := waitForCanaryEvents(t, second.bus, 2)
	if events == nil {
		t.Fatalf("restart canary did not emit receipt, winner, and fired handler; bus=%+v", second.bus.snapshot())
	}
	assertLatestCanaryOnly(t, second.bus, events)
}

func TestSchedulerMissedCanary_ClockJumpSelectsLatest(t *testing.T) {
	persistDir := t.TempDir()
	before := time.Date(2026, 5, 25, 8, 0, 0, 0, time.UTC)
	h := newMissedCanaryHarness(t, persistDir, before)
	h.tick() // Register first-seen anchors while alive.
	*h.now = time.Date(2026, 5, 25, 11, 0, 0, 0, time.UTC)
	h.tick() // Model in-process suspend/resume with an overdue clock jump.
	events := waitForCanaryEvents(t, h.bus, 2)
	if events == nil {
		t.Fatalf("clock-jump canary did not emit receipt, winner, and fired handler; bus=%+v", h.bus.snapshot())
	}
	assertLatestCanaryOnly(t, h.bus, events)
}
