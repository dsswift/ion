package watcher

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// collector is a thread-safe sink for events delivered by the watcher. Tests
// drive the watcher then call wait() to block until at least n events have
// arrived (or a timeout fires).
type collector struct {
	mu     sync.Mutex
	events []Info
	cond   *sync.Cond
}

func newCollector() *collector {
	c := &collector{}
	c.cond = sync.NewCond(&c.mu)
	return c
}

func (c *collector) onEvent(info Info) {
	c.mu.Lock()
	c.events = append(c.events, info)
	c.cond.Broadcast()
	c.mu.Unlock()
}

// wait blocks until len(events) >= want, or the timeout elapses. Returns a
// copy of the events slice so callers can inspect without races.
func (c *collector) wait(want int, timeout time.Duration) []Info {
	deadline := time.Now().Add(timeout)
	c.mu.Lock()
	defer c.mu.Unlock()
	for len(c.events) < want {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		// Use a goroutine + timer to unblock the cond wait after `remaining`.
		// sync.Cond has no built-in timeout, but a one-shot waker is fine.
		done := make(chan struct{})
		timer := time.AfterFunc(remaining, func() {
			c.mu.Lock()
			c.cond.Broadcast()
			c.mu.Unlock()
			close(done)
		})
		c.cond.Wait()
		timer.Stop()
		// Re-check loop condition; if we were woken by timer we'll exit on
		// the next deadline check.
		select {
		case <-done:
		default:
		}
	}
	out := make([]Info, len(c.events))
	copy(out, c.events)
	return out
}

// snapshot returns a copy of events without blocking. Used to assert "no
// events were delivered" after a fixed quiet period.
func (c *collector) snapshot() []Info {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Info, len(c.events))
	copy(out, c.events)
	return out
}

// setupWatcher creates a temp dir, constructs a Watcher with the given
// ignores, starts it with a collector, and returns the components plus a
// cleanup. The temp dir is removed on cleanup.
func setupWatcher(t *testing.T, ignores []string) (root string, c *collector, w *Watcher, cleanup func()) {
	t.Helper()
	root = t.TempDir()
	c = newCollector()
	var err error
	w, err = New(root, ignores)
	if err != nil {
		t.Fatalf("New failed: %v", err)
	}
	if err := w.Start(context.Background(), c.onEvent); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	// fsnotify needs a beat to settle after Start before writes will be
	// reliably observed on all platforms.
	time.Sleep(20 * time.Millisecond)
	cleanup = func() {
		_ = w.Close()
	}
	return
}

func TestNew_ValidatesRoot(t *testing.T) {
	if _, err := New("", nil); err == nil {
		t.Fatal("expected error for empty root")
	}
	if _, err := New("/this/path/does/not/exist/ion-test", nil); err == nil {
		t.Fatal("expected error for missing root")
	}
	// File (not directory) root is rejected.
	tmp := t.TempDir()
	f := filepath.Join(tmp, "file.txt")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := New(f, nil); err == nil {
		t.Fatal("expected error when root is a file")
	}
}

func TestWatcher_DetectsCreateModifyDelete(t *testing.T) {
	root, c, _, cleanup := setupWatcher(t, nil)
	defer cleanup()

	target := filepath.Join(root, "hello.txt")

	// Create
	if err := os.WriteFile(target, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	events := c.wait(1, 500*time.Millisecond)
	if len(events) < 1 {
		t.Fatalf("no event for file create; got %d events: %+v", len(events), events)
	}
	first := events[0]
	if first.RelPath != "hello.txt" {
		t.Errorf("RelPath = %q, want %q", first.RelPath, "hello.txt")
	}
	if first.Action != ActionCreate && first.Action != ActionModify {
		// Platforms differ: some report Create then Write; the debouncer
		// collapses to whichever fsnotify reported last. Both are acceptable
		// for a "new file with content" event.
		t.Errorf("Action = %q, want create or modify", first.Action)
	}

	// Modify (separate event after debounce window so it's not collapsed).
	time.Sleep(2 * debounceWindow)
	if err := os.WriteFile(target, []byte("world"), 0o644); err != nil {
		t.Fatal(err)
	}
	events = c.wait(2, 500*time.Millisecond)
	if len(events) < 2 {
		t.Fatalf("no event for file modify; got %d events: %+v", len(events), events)
	}
	if events[1].Action != ActionModify {
		t.Errorf("Action[1] = %q, want modify", events[1].Action)
	}

	// Delete.
	time.Sleep(2 * debounceWindow)
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	events = c.wait(3, 500*time.Millisecond)
	if len(events) < 3 {
		t.Fatalf("no event for file delete; got %d events: %+v", len(events), events)
	}
	if events[2].Action != ActionDelete {
		t.Errorf("Action[2] = %q, want delete", events[2].Action)
	}
}

func TestWatcher_DynamicallyAttachesNewSubdir(t *testing.T) {
	root, c, _, cleanup := setupWatcher(t, nil)
	defer cleanup()

	// Create a nested dir after the watcher is running.
	nested := filepath.Join(root, "sub", "deep")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	// Wait for the directory-create events to settle and the auto-attach to
	// take effect. attachSubtree runs synchronously inside the pump goroutine
	// before the next event is processed, but giving fsnotify a moment to
	// register the new dir avoids flake on slower CI.
	time.Sleep(100 * time.Millisecond)

	// Write inside the freshly-attached subdir.
	target := filepath.Join(nested, "nested.txt")
	if err := os.WriteFile(target, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Poll until the nested file event arrives or timeout. We can't just
	// wait(n, ...) because the synthesized Create events for sub and
	// sub/deep arrive first and we'd return before the file event.
	deadline := time.Now().Add(1 * time.Second)
	found := false
	var lastEvents []Info
	for time.Now().Before(deadline) {
		lastEvents = c.snapshot()
		for _, e := range lastEvents {
			if filepath.ToSlash(e.RelPath) == "sub/deep/nested.txt" {
				found = true
				break
			}
		}
		if found {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !found {
		t.Fatalf("no event for nested file write; got events: %+v", lastEvents)
	}
}

func TestWatcher_HonorsIgnorePatterns(t *testing.T) {
	ignores := []string{"ignored/**", "node_modules/**", "*.log"}
	root, c, _, cleanup := setupWatcher(t, ignores)
	defer cleanup()

	// Create ignored subtree -- should NOT produce events.
	if err := os.MkdirAll(filepath.Join(root, "ignored", "deep"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "ignored", "deep", "x.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Create ignored file by extension -- should NOT produce events.
	if err := os.WriteFile(filepath.Join(root, "debug.log"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Create non-ignored file -- SHOULD produce an event.
	if err := os.WriteFile(filepath.Join(root, "watched.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Wait for at least one event, then drain past the debounce window so
	// any ignored-path events that might have leaked through have time to
	// surface (and fail the test below).
	_ = c.wait(1, 500*time.Millisecond)
	time.Sleep(2 * debounceWindow)
	events := c.snapshot()

	for _, e := range events {
		if e.RelPath == "debug.log" {
			t.Errorf("ignored file produced an event: %+v", e)
		}
		if filepath.ToSlash(e.RelPath) == "ignored/deep/x.txt" {
			t.Errorf("ignored subtree produced an event: %+v", e)
		}
	}
	found := false
	for _, e := range events {
		if e.RelPath == "watched.txt" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("watched file did not produce an event; got: %+v", events)
	}
}

func TestWatcher_CoalescesRapidWrites(t *testing.T) {
	root, c, _, cleanup := setupWatcher(t, nil)
	defer cleanup()

	target := filepath.Join(root, "burst.txt")
	// Burst of 5 writes within the debounce window. Should collapse to 1
	// event (possibly split into 2 on some platforms where Create + Write
	// are reported as separate ops outside our window -- be liberal).
	for i := 0; i < 5; i++ {
		if err := os.WriteFile(target, []byte{byte('a' + i)}, 0o644); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Wait well past the debounce window.
	time.Sleep(4 * debounceWindow)
	events := c.snapshot()
	if len(events) == 0 {
		t.Fatalf("no events from burst writes")
	}
	if len(events) > 2 {
		t.Errorf("burst not coalesced; got %d events, want <= 2: %+v", len(events), events)
	}
}

func TestWatcher_CloseIsSafeAndIdempotent(t *testing.T) {
	root := t.TempDir()
	w, err := New(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Close before Start is a no-op.
	if err := w.Close(); err != nil {
		t.Errorf("Close before Start failed: %v", err)
	}

	// Fresh watcher: Start, Close, Close again.
	w, err = New(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := newCollector()
	if err := w.Start(context.Background(), c.onEvent); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Errorf("Close failed: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Errorf("second Close failed: %v", err)
	}

	// Events arriving after Close must NOT fire the callback. Create a file
	// in the watched root after close -- the fsnotify watcher is gone, but
	// even if a stray event leaked through, deliverFunc's closed-check
	// should drop it.
	if err := os.WriteFile(filepath.Join(root, "post-close.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(3 * debounceWindow)
	if got := len(c.snapshot()); got != 0 {
		t.Errorf("event delivered after Close; got %d events", got)
	}
}

func TestWatcher_InvalidIgnorePatternRejected(t *testing.T) {
	root := t.TempDir()
	// doublestar.Match returns error on malformed patterns like a bare `[`.
	if _, err := New(root, []string{"["}); err == nil {
		t.Fatal("expected error for invalid ignore pattern")
	}
}

func TestWatcher_StartTwiceErrors(t *testing.T) {
	root := t.TempDir()
	w, err := New(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	c := newCollector()
	if err := w.Start(context.Background(), c.onEvent); err != nil {
		t.Fatal(err)
	}
	if err := w.Start(context.Background(), c.onEvent); err == nil {
		t.Fatal("expected error on double Start")
	}
}
