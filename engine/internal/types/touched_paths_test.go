package types

import (
	"context"
	"sync"
	"testing"
)

func TestTouchedPathSink_AddDrainClear(t *testing.T) {
	s := NewTouchedPathSink()
	s.Add("/a")
	s.Add("/b")
	s.Add("") // ignored

	got := s.DrainAndClear()
	if len(got) != 2 {
		t.Fatalf("expected 2 paths, got %d: %v", len(got), got)
	}
	if got[0] != "/a" || got[1] != "/b" {
		t.Errorf("unexpected paths: %v", got)
	}

	// After drain the sink is empty.
	if again := s.DrainAndClear(); again != nil {
		t.Errorf("expected nil after clear, got %v", again)
	}
}

func TestTouchedPathSink_NilSafe(t *testing.T) {
	var s *TouchedPathSink
	s.Add("/x")                  // must not panic
	if s.DrainAndClear() != nil { // must not panic
		t.Error("nil sink should drain to nil")
	}
}

func TestRecordTouchedPath_NoSinkIsNoOp(t *testing.T) {
	// A context with no sink installed must not panic and must not error.
	RecordTouchedPath(context.Background(), "/some/path")
}

func TestRecordTouchedPath_WithSink(t *testing.T) {
	s := NewTouchedPathSink()
	ctx := WithTouchedPathSink(context.Background(), s)

	RecordTouchedPath(ctx, "/recorded")
	RecordTouchedPath(ctx, "") // ignored

	got := s.DrainAndClear()
	if len(got) != 1 || got[0] != "/recorded" {
		t.Fatalf("expected [/recorded], got %v", got)
	}
}

func TestTouchedPathSinkFrom_AbsentReturnsNil(t *testing.T) {
	if s := TouchedPathSinkFrom(context.Background()); s != nil {
		t.Errorf("expected nil sink from bare context, got %v", s)
	}
}

// Race coverage: many goroutines Add while a drain runs concurrently.
func TestTouchedPathSink_ConcurrentAdd(t *testing.T) {
	s := NewTouchedPathSink()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.Add("/p")
		}()
	}
	// Concurrent drain while writers are active.
	go func() { _ = s.DrainAndClear() }()
	wg.Wait()
	// Final drain to flush any stragglers; just assert no panic/race.
	_ = s.DrainAndClear()
}
