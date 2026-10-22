package session

import (
	"context"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/watcher"
)

// holdWatcherStart replaces the pool's watcher start with one that waits on
// the returned channel before starting for real. Restored on cleanup.
func holdWatcherStart(t *testing.T) (started <-chan struct{}, proceed chan<- struct{}) {
	t.Helper()
	startedCh := make(chan struct{})
	proceedCh := make(chan struct{})
	prev := watcherStart
	watcherStart = func(w *watcher.Watcher, onEvent func(watcher.Info)) error {
		close(startedCh)
		<-proceedCh
		return w.Start(context.Background(), onEvent)
	}
	t.Cleanup(func() { watcherStart = prev })
	return startedCh, proceedCh
}

func noopSubscriber() func(watcher.Info) {
	return func(watcher.Info) {}
}

// TestWatcherPool_AcquireDoesNotWaitForStart pins the contract that lets a
// session start on a huge working directory: acquire returns before the
// watcher has walked the tree, a second session shares the entry while it is
// still starting, and ready closes once the start has finished.
//
// Regression guard: an acquire that calls Start inline never returns while
// the start is held, and the first select times out.
func TestWatcherPool_AcquireDoesNotWaitForStart(t *testing.T) {
	started, proceed := holdWatcherStart(t)
	p := newWatcherPool()
	root := t.TempDir()

	type result struct {
		release func()
		ready   <-chan struct{}
		err     error
	}
	got := make(chan result, 1)
	go func() {
		release, ready, err := p.acquire(root, nil, "s1", 0, renameSettings{}, noopSubscriber())
		got <- result{release, ready, err}
	}()
	var first result
	select {
	case first = <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("acquire waited on the watcher start")
	}
	if first.err != nil {
		t.Fatalf("acquire: %v", first.err)
	}
	<-started
	select {
	case <-first.ready:
		t.Fatal("ready closed before the start finished")
	default:
	}

	release2, ready2, err := p.acquire(root, nil, "s2", 0, renameSettings{}, noopSubscriber())
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	if ready2 != first.ready {
		t.Fatal("second acquire did not share the entry that is still starting")
	}

	close(proceed)
	select {
	case <-first.ready:
	case <-time.After(5 * time.Second):
		t.Fatal("ready never closed after the start was released")
	}
	release2()
	first.release()
	p.mu.Lock()
	remaining := len(p.entries)
	p.mu.Unlock()
	if remaining != 0 {
		t.Errorf("pool holds %d entries after both releases, want 0", remaining)
	}
}

// TestWatcherPool_ReleaseDuringStartEndsIt proves a session that stops while
// its watcher is still starting neither waits on the start nor leaves an
// entry behind: the start ends as a benign early close and the pool is empty.
func TestWatcherPool_ReleaseDuringStartEndsIt(t *testing.T) {
	started, proceed := holdWatcherStart(t)
	p := newWatcherPool()
	root := t.TempDir()

	release, ready, err := p.acquire(root, nil, "s1", 0, renameSettings{}, noopSubscriber())
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	<-started

	done := make(chan struct{})
	go func() {
		release()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("release waited on the watcher start")
	}

	close(proceed)
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("ready never closed after the start was released")
	}
	p.mu.Lock()
	remaining := len(p.entries)
	p.mu.Unlock()
	if remaining != 0 {
		t.Errorf("pool holds %d entries after release during start, want 0", remaining)
	}
}
