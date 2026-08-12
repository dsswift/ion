package scheduling

import (
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

type lockedTestClock struct {
	mu  sync.RWMutex
	now time.Time
}

func newLockedTestClock(now time.Time) *lockedTestClock {
	return &lockedTestClock{now: now}
}

func (c *lockedTestClock) Now() time.Time {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.now
}

func (c *lockedTestClock) Set(now time.Time) {
	c.mu.Lock()
	c.now = now
	c.mu.Unlock()
}

func (c *lockedTestClock) Add(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// do not flood INFO. First skip and every 30th emit INFO; intermediate
// ticks emit DEBUG only.
func TestInFlightSkip_NoRepeatedINFO(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "slow-job",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 1000,
	}
	h := testHostWithSchedule(t, "ext-a", job)

	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) {})

	baseTime := time.Date(2026, 6, 6, 10, 0, 0, 0, time.UTC)
	clock := newLockedTestClock(baseTime)
	s.nowFn = clock.Now

	// Resolver that blocks forever (simulates long-running fire).
	blockCh := make(chan struct{})
	defer close(blockCh)
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		<-blockCh
		return &extension.Context{SessionKey: "test"}, nil
	})

	s.AddHost(h)

	// First tick: bootstrap nextRun.
	s.tickOnce()

	// Advance past interval so the job is due.
	clock.Set(baseTime.Add(2 * time.Second))

	// Second tick: fires the job (blocks in goroutine).
	s.tickOnce()
	// Give goroutine time to enter resolver.
	time.Sleep(10 * time.Millisecond)

	// Enable DEBUG so the sink sees all levels.
	utils.SetLevel(utils.LevelDebug)
	defer utils.SetLevel(utils.LevelInfo)

	// Install log sink to capture subsequent skip logs.
	var mu sync.Mutex
	type logEntry struct {
		level utils.LogLevel
		msg   string
	}
	var logs []logEntry

	utils.SetTestSink(func(level utils.LogLevel, tag, msg string, fields map[string]any, _, _ string) {
		if tag == "scheduling" && (msg == "in-flight skip summary" || msg == "in-flight skip") {
			mu.Lock()
			logs = append(logs, logEntry{level: level, msg: msg})
			mu.Unlock()
		}
	})
	defer utils.SetTestSink(nil)

	// Tick 60 more times while job is in-flight.
	for i := 0; i < 60; i++ {
		clock.Add(time.Second)
		s.tickOnce()
	}

	mu.Lock()
	captured := append([]logEntry(nil), logs...)
	mu.Unlock()

	if len(captured) != 60 {
		t.Fatalf("expected 60 log entries, got %d", len(captured))
	}

	// Count INFO vs DEBUG entries.
	infoCount := 0
	debugCount := 0
	for _, e := range captured {
		switch e.level {
		case utils.LevelInfo:
			infoCount++
		case utils.LevelDebug:
			debugCount++
		}
	}

	// First skip (count=1) and 30th (count=30) and 60th (count=60) = 3 INFO.
	if infoCount != 3 {
		t.Errorf("expected 3 INFO-level skip logs (1st, 30th, 60th), got %d", infoCount)
	}
	if debugCount != 57 {
		t.Errorf("expected 57 DEBUG-level skip logs, got %d", debugCount)
	}

	// Verify first entry is INFO (summary).
	if captured[0].level != utils.LevelInfo {
		t.Errorf("first skip should be INFO, got %v", captured[0].level)
	}
	if captured[0].msg != "in-flight skip summary" {
		t.Errorf("first skip msg should be 'in-flight skip summary', got %q", captured[0].msg)
	}

	// Verify second entry is DEBUG.
	if captured[1].level != utils.LevelDebug {
		t.Errorf("second skip should be DEBUG, got %v", captured[1].level)
	}
}

// TestInFlightSkip_SingleFlight verifies that a job in-flight is never
// double-fired -- the in-flight guard prevents concurrent execution.
func TestInFlightSkip_SingleFlight(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "guarded-job",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 1000,
	}
	h := testHostWithSchedule(t, "ext-b", job)

	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) {})

	baseTime := time.Date(2026, 6, 6, 10, 0, 0, 0, time.UTC)
	clock := newLockedTestClock(baseTime)
	s.nowFn = clock.Now

	var mu sync.Mutex
	fireCount := 0
	blockCh := make(chan struct{})
	defer close(blockCh)

	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		mu.Lock()
		fireCount++
		mu.Unlock()
		<-blockCh
		return &extension.Context{SessionKey: "test"}, nil
	})

	s.AddHost(h)

	// Bootstrap.
	s.tickOnce()

	// Advance and fire.
	clock.Set(baseTime.Add(2 * time.Second))
	s.tickOnce()
	time.Sleep(10 * time.Millisecond)

	// Tick many more times -- none should enter resolver.
	for i := 0; i < 20; i++ {
		clock.Add(time.Second)
		s.tickOnce()
	}

	mu.Lock()
	got := fireCount
	mu.Unlock()

	if got != 1 {
		t.Fatalf("expected exactly 1 fire while in-flight, got %d", got)
	}
}

// TestInFlightSkip_CounterResets verifies that the skip counter resets
// after a fire completes, so the next in-flight period starts fresh.
func TestInFlightSkip_CounterResets(t *testing.T) {
	job := extension.ScheduleJob{
		JobID:      "reset-job",
		Kind:       extension.ScheduleInterval,
		IntervalMs: 1000,
	}
	h := extension.NewHost()
	h.SetNameForTest("ext-c")
	err := h.AsyncRegistry().Register(asyncreg.KindSchedule, job, asyncreg.OriginInit, nil)
	if err != nil {
		t.Fatal(err)
	}

	s := New(Config{})
	s.SetEmit(func(ev types.EngineEvent) {})

	baseTime := time.Date(2026, 6, 6, 10, 0, 0, 0, time.UTC)
	clock := newLockedTestClock(baseTime)
	s.nowFn = clock.Now

	// Resolver that completes immediately.
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "test"}, nil
	})
	// FireAsync needs a handler that won't error -- set up host to not
	// actually dispatch (it will fail since no subprocess is running).
	// Instead we use the blocking approach: block the first fire, tick
	// a few times, then unblock, then fire again and verify fresh count.

	blockCh := make(chan struct{})
	callCount := 0
	s.SetSessionResolver(func(host *extension.Host) (*extension.Context, error) {
		callCount++
		if callCount == 1 {
			<-blockCh
		}
		return &extension.Context{SessionKey: "test"}, nil
	})

	s.AddHost(h)
	s.tickOnce() // bootstrap

	clock.Set(baseTime.Add(2 * time.Second))
	s.tickOnce() // fires (blocks)
	time.Sleep(10 * time.Millisecond)

	// Tick 5 times while blocked -- accumulates skip state.
	for i := 0; i < 5; i++ {
		clock.Add(time.Second)
		s.tickOnce()
	}

	// Verify skip state exists.
	key := hostJobKey{host: h, id: job.JobID}
	raw, loaded := s.inFlightSkips.Load(key)
	if !loaded {
		t.Fatal("expected inFlightSkips entry while in-flight")
	}
	state := raw.(*inFlightSkipState)
	if state.count != 5 {
		t.Fatalf("expected 5 skips, got %d", state.count)
	}

	// Unblock the fire.
	close(blockCh)
	time.Sleep(50 * time.Millisecond)

	// After fire completes, skip state should be cleared.
	_, loaded = s.inFlightSkips.Load(key)
	if loaded {
		t.Fatal("expected inFlightSkips to be cleared after fire completes")
	}
}
