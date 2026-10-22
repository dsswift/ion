package watcher

import (
	"context"
	"errors"
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

// withMaxWatchedDirs temporarily lowers the directory cap for the duration of
// a test and restores it on cleanup. Lets the cap tests exercise truncation
// without materializing 50_000 directories.
func withMaxWatchedDirs(t *testing.T, n int) {
	t.Helper()
	prev := maxWatchedDirs
	maxWatchedDirs = n
	t.Cleanup(func() { maxWatchedDirs = prev })
}

// withDirectorySource makes watchers started during the test use the
// per-directory source, the only kind the directory cap applies to, whatever
// the platform's own source is. Restored on cleanup.
func withDirectorySource(t *testing.T) {
	t.Helper()
	prev := newEventSource
	newEventSource = newDirectorySource
	t.Cleanup(func() { newEventSource = prev })
}

// withCapWarnCounter swaps the cap-warning sink for a counting one and returns
// a func that reads the current count. Restored on cleanup.
func withCapWarnCounter(t *testing.T) (count func() int) {
	t.Helper()
	var mu sync.Mutex
	n := 0
	prev := capWarnLogger
	capWarnLogger = func(tag, msg string) {
		mu.Lock()
		n++
		mu.Unlock()
	}
	t.Cleanup(func() { capWarnLogger = prev })
	return func() int {
		mu.Lock()
		defer mu.Unlock()
		return n
	}
}

// snapshotState reads the cap-related fields under the watcher lock.
func (w *Watcher) snapshotState() (truncated bool, attached int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.truncated, w.attachedCount
}

// TestWatcher_StartRespectsDirCap builds a tree with more directories than the
// (lowered) cap and asserts the Start() walk stops attaching at the cap, sets
// the truncated flag, and logs the cap-hit warning exactly once.
//
// Regression guard: reverting the cap enforcement in Start() lets attachedCount
// climb to the full directory count and leaves truncated false, failing the
// assertions below.
func TestWatcher_StartRespectsDirCap(t *testing.T) {
	withDirectorySource(t)
	const cap = 5
	const dirCount = 12
	withMaxWatchedDirs(t, cap)
	warnCount := withCapWarnCounter(t)

	root := t.TempDir()
	// Create dirCount sibling directories under root. With the root itself,
	// the walk sees dirCount+1 directories, comfortably above the cap.
	for i := 0; i < dirCount; i++ {
		if err := os.MkdirAll(filepath.Join(root, "d"+string(rune('a'+i))), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	w, err := New(root, nil)
	if err != nil {
		t.Fatalf("New failed: %v", err)
	}
	c := newCollector()
	if err := w.Start(context.Background(), c.onEvent); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer w.Close()

	truncated, attached := w.snapshotState()
	if !truncated {
		t.Errorf("truncated = false, want true when tree exceeds cap")
	}
	if attached != cap {
		t.Errorf("attachedCount = %d, want exactly cap=%d", attached, cap)
	}
	if attached > cap {
		t.Errorf("attachedCount = %d exceeded cap=%d", attached, cap)
	}
	if got := warnCount(); got != 1 {
		t.Errorf("cap-hit warning fired %d times, want exactly 1", got)
	}
}

// TestWatcher_NewWithMaxDirs_HonorsExplicitCap proves the per-watcher cap
// argument overrides the package default: a watcher constructed with an
// explicit small cap truncates at that cap regardless of the (large) package
// default. This is the configurability path used by engine.json's
// workspace.maxWatchedDirs.
func TestWatcher_NewWithMaxDirs_HonorsExplicitCap(t *testing.T) {
	withDirectorySource(t)
	// Leave the package default at its real (large) value: the explicit cap
	// must win on its own.
	warnCount := withCapWarnCounter(t)
	const explicitCap = 3
	const dirCount = 9

	root := t.TempDir()
	for i := 0; i < dirCount; i++ {
		if err := os.MkdirAll(filepath.Join(root, "x"+string(rune('a'+i))), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	w, err := NewWithMaxDirs(root, nil, explicitCap)
	if err != nil {
		t.Fatalf("NewWithMaxDirs failed: %v", err)
	}
	c := newCollector()
	if err := w.Start(context.Background(), c.onEvent); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer w.Close()

	truncated, attached := w.snapshotState()
	if !truncated {
		t.Error("truncated = false, want true with explicit small cap")
	}
	if attached != explicitCap {
		t.Errorf("attachedCount = %d, want explicit cap=%d", attached, explicitCap)
	}
	if got := warnCount(); got != 1 {
		t.Errorf("cap-hit warning fired %d times, want exactly 1", got)
	}
}

// TestWatcher_NewWithMaxDirsZeroUsesDefault proves that a zero cap falls back
// to the package default (the "config omitted" path).
func TestWatcher_NewWithMaxDirsZeroUsesDefault(t *testing.T) {
	withDirectorySource(t)
	withMaxWatchedDirs(t, 4) // lower the default so the test is cheap

	root := t.TempDir()
	for i := 0; i < 8; i++ {
		if err := os.MkdirAll(filepath.Join(root, "z"+string(rune('a'+i))), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	w, err := NewWithMaxDirs(root, nil, 0) // zero → use default (now 4)
	if err != nil {
		t.Fatalf("NewWithMaxDirs failed: %v", err)
	}
	c := newCollector()
	if err := w.Start(context.Background(), c.onEvent); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer w.Close()

	_, attached := w.snapshotState()
	if attached != 4 {
		t.Errorf("attachedCount = %d, want package default cap=4 when maxDirs=0", attached)
	}
}

// TestWatcher_SubtreeAttachRespectsDirCap asserts the lifetime cap is also
// enforced on the dynamic attachSubtree path: once Start() has consumed the
// whole cap, a newly-created subtree attaches no further directories and the
// warning still fires exactly once across both walks.
func TestWatcher_SubtreeAttachRespectsDirCap(t *testing.T) {
	withDirectorySource(t)
	const cap = 2
	withMaxWatchedDirs(t, cap)
	warnCount := withCapWarnCounter(t)

	root := t.TempDir()
	// One subdir so Start() attaches root + sub = 2 dirs, hitting the cap.
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}

	w, err := New(root, nil)
	if err != nil {
		t.Fatalf("New failed: %v", err)
	}
	c := newCollector()
	if err := w.Start(context.Background(), c.onEvent); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer w.Close()
	time.Sleep(20 * time.Millisecond)

	_, attachedAfterStart := w.snapshotState()
	if attachedAfterStart != cap {
		t.Fatalf("attachedCount after Start = %d, want cap=%d", attachedAfterStart, cap)
	}

	// Create a fresh subtree after the cap is already exhausted. attachSubtree
	// must not push attachedCount past the cap.
	nested := filepath.Join(root, "late", "deep")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)

	truncated, attached := w.snapshotState()
	if !truncated {
		t.Errorf("truncated = false, want true after subtree attach hit cap")
	}
	if attached != cap {
		t.Errorf("attachedCount = %d, want it pinned at cap=%d after subtree attach", attached, cap)
	}
	if got := warnCount(); got != 1 {
		t.Errorf("cap-hit warning fired %d times across both walks, want exactly 1", got)
	}
}

// withRecursiveSource makes watchers use a per-directory source that reports
// itself recursive, so the Start walk takes the seed-only path the FSEvents
// and Windows sources take, on every platform. Restored on cleanup.
func withRecursiveSource(t *testing.T) {
	t.Helper()
	prev := newEventSource
	newEventSource = func(root string) (eventSource, error) {
		src, err := newDirectorySource(root)
		if err != nil {
			return nil, err
		}
		return recursiveTestSource{src}, nil
	}
	t.Cleanup(func() { newEventSource = prev })
}

type recursiveTestSource struct{ eventSource }

func (recursiveTestSource) Recursive() bool { return true }

// withStartWalkVisit installs a per-directory hook on the Start walk.
// Restored on cleanup.
func withStartWalkVisit(t *testing.T, fn func(dir string)) {
	t.Helper()
	prev := startWalkVisit
	startWalkVisit = fn
	t.Cleanup(func() { startWalkVisit = prev })
}

func makeSiblingDirs(t *testing.T, root string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if err := os.MkdirAll(filepath.Join(root, "d"+string(rune('a'+i))), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

// TestWatcher_RecursiveSeedWalkRespectsDirCap proves the directory cap bounds
// the rename-seeding walk a recursive source runs, which attaches nothing and
// used to be unbounded: a root like a home directory walked to the end.
//
// Regression guard: without the cap on the recursive path the walk enters
// every directory, visited reaches dirCount+1, and truncated stays false.
func TestWatcher_RecursiveSeedWalkRespectsDirCap(t *testing.T) {
	withRecursiveSource(t)
	const cap = 5
	const dirCount = 12
	warnCount := withCapWarnCounter(t)

	root := t.TempDir()
	makeSiblingDirs(t, root, dirCount)

	var mu sync.Mutex
	visited := 0
	withStartWalkVisit(t, func(string) {
		mu.Lock()
		visited++
		mu.Unlock()
	})

	w, err := NewWithOptions(root, nil, Options{MaxDirs: cap, TrackRenames: func(string) bool { return true }})
	if err != nil {
		t.Fatalf("NewWithOptions failed: %v", err)
	}
	c := newCollector()
	if err := w.Start(context.Background(), c.onEvent); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer w.Close()

	truncated, attached := w.snapshotState()
	if !truncated {
		t.Errorf("truncated = false, want true when the seed walk exceeds the cap")
	}
	if attached != 0 {
		t.Errorf("attachedCount = %d, want 0: a recursive source attaches nothing", attached)
	}
	mu.Lock()
	got := visited
	mu.Unlock()
	// The root and cap more directories are entered; the one past the cap
	// is visited, counted, and ends the walk.
	if got != cap+1 {
		t.Errorf("walk entered %d directories, want %d (cap+1)", got, cap+1)
	}
	if got := warnCount(); got != 1 {
		t.Errorf("cap-hit warning fired %d times, want exactly 1", got)
	}
}

// TestWatcher_CloseDuringStartWalkStopsWalk proves a Close that lands while
// Start is walking ends the walk at the next directory, makes Start return
// ErrClosedDuringStart, and leaves nothing behind: a later Close returns at
// once (no pump to wait on) and Start cannot be retried.
//
// Regression guard: without the closed check in the walk, Start visits every
// directory and then launches a pump on a closed watcher, and the second
// Close blocks forever on the pump it never joins.
func TestWatcher_CloseDuringStartWalkStopsWalk(t *testing.T) {
	withDirectorySource(t)
	const dirCount = 12
	root := t.TempDir()
	makeSiblingDirs(t, root, dirCount)

	w, err := New(root, nil)
	if err != nil {
		t.Fatalf("New failed: %v", err)
	}
	var mu sync.Mutex
	visited := 0
	withStartWalkVisit(t, func(string) {
		mu.Lock()
		visited++
		n := visited
		mu.Unlock()
		if n == 2 {
			if err := w.Close(); err != nil {
				t.Errorf("Close during walk: %v", err)
			}
		}
	})

	c := newCollector()
	err = w.Start(context.Background(), c.onEvent)
	if !errors.Is(err, ErrClosedDuringStart) {
		t.Fatalf("Start error = %v, want ErrClosedDuringStart", err)
	}
	mu.Lock()
	got := visited
	mu.Unlock()
	if got != 2 {
		t.Errorf("walk entered %d directories after Close, want 2 (the one that closed it, then stop)", got)
	}

	done := make(chan struct{})
	go func() {
		w.Close() //nolint:errcheck // asserting it returns, not its value
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("second Close blocked: a pump was launched on a closed watcher")
	}
	if err := w.Start(context.Background(), c.onEvent); err == nil {
		t.Error("Start after Close succeeded, want refusal")
	}
}
