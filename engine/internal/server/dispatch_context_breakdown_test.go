package server

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/protocol"
)

// TestGetContextBreakdownDoesNotBlockConnectionReadLoop pins the production
// regression where provider token counting held the socket dispatch loop for
// ~48 seconds. Commands queued behind it timed out client-side even though they
// executed once the breakdown finished.
func TestGetContextBreakdownDoesNotBlockConnectionReadLoop(t *testing.T) {
	srv := newShortPathTestServer(t, newMockBackend())
	started := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	srv.computeContextBreakdown = func(_ context.Context, key string) error {
		close(started)
		<-release
		close(done)
		return nil
	}

	begin := time.Now()
	srv.dispatch(nil, &protocol.ClientCommand{Cmd: "get_context_breakdown", Key: "slow-session"})
	if elapsed := time.Since(begin); elapsed > 100*time.Millisecond {
		t.Fatalf("dispatch blocked socket loop for %s", elapsed)
	}

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("background context breakdown did not start")
	}

	// A command queued behind breakdown must execute immediately. list_sessions
	// is synchronous and side-effect free; returning proves dispatch remains open.
	begin = time.Now()
	srv.dispatch(nil, &protocol.ClientCommand{Cmd: "list_sessions"})
	if elapsed := time.Since(begin); elapsed > 100*time.Millisecond {
		t.Fatalf("subsequent command blocked behind context breakdown for %s", elapsed)
	}

	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("background context breakdown did not complete")
	}
}

func TestGetContextBreakdownPanicDoesNotCrashServer(t *testing.T) {
	srv := newShortPathTestServer(t, newMockBackend())
	started := make(chan struct{})
	srv.computeContextBreakdown = func(context.Context, string) error {
		close(started)
		panic("provider counter panic")
	}

	srv.dispatch(nil, &protocol.ClientCommand{Cmd: "get_context_breakdown", Key: "panic-session"})
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("background context breakdown did not start")
	}

	// Give the recovery defer time to run, then prove dispatch still works.
	time.Sleep(10 * time.Millisecond)
	srv.dispatch(nil, &protocol.ClientCommand{Cmd: "list_sessions"})
}

func TestGetContextBreakdownCoalescesConcurrentRequests(t *testing.T) {
	srv := newShortPathTestServer(t, newMockBackend())
	started := make(chan struct{})
	release := make(chan struct{})
	calls := 0
	var callsMu sync.Mutex
	srv.computeContextBreakdown = func(_ context.Context, _ string) error {
		callsMu.Lock()
		calls++
		callsMu.Unlock()
		close(started)
		<-release
		return nil
	}

	srv.dispatch(nil, &protocol.ClientCommand{Cmd: "get_context_breakdown", Key: "same-session"})
	<-started
	srv.dispatch(nil, &protocol.ClientCommand{Cmd: "get_context_breakdown", Key: "same-session"})
	time.Sleep(10 * time.Millisecond)
	callsMu.Lock()
	got := calls
	callsMu.Unlock()
	if got != 1 {
		t.Fatalf("concurrent breakdown calls = %d, want 1", got)
	}
	close(release)
}

func TestGetContextBreakdownStopCancelsWorker(t *testing.T) {
	srv := newShortPathTestServer(t, newMockBackend())
	started := make(chan struct{})
	cancelled := make(chan struct{})
	srv.computeContextBreakdown = func(ctx context.Context, _ string) error {
		close(started)
		<-ctx.Done()
		close(cancelled)
		return ctx.Err()
	}

	srv.dispatch(nil, &protocol.ClientCommand{Cmd: "get_context_breakdown", Key: "stopped-session"})
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("context breakdown did not start")
	}

	stopped := make(chan struct{})
	go func() {
		_ = srv.Stop()
		close(stopped)
	}()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("Stop did not cancel context breakdown")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("Stop waited indefinitely for context breakdown")
	}
}

func TestGetContextBreakdownSkippedAfterShutdownBegins(t *testing.T) {
	srv := newShortPathTestServer(t, newMockBackend())
	called := make(chan struct{}, 1)
	srv.computeContextBreakdown = func(context.Context, string) error {
		called <- struct{}{}
		return nil
	}
	if err := srv.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	srv.startContextBreakdown("stopped-session")
	select {
	case <-called:
		t.Fatal("context breakdown started after shutdown")
	case <-time.After(20 * time.Millisecond):
	}
}

func TestGetContextBreakdownWorkerReturnsCancellation(t *testing.T) {
	srv := newShortPathTestServer(t, newMockBackend())
	started := make(chan struct{})
	srv.computeContextBreakdown = func(ctx context.Context, _ string) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}
	srv.startContextBreakdown("cancelled-session")
	<-started
	if err := srv.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if !errors.Is(srv.shutdownCtx.Err(), context.Canceled) {
		t.Fatalf("shutdown context error = %v, want context.Canceled", srv.shutdownCtx.Err())
	}
}
