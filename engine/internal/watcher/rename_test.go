package watcher

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

// trackMarkdown selects the files rename tests follow.
func trackMarkdown(rel string) bool { return strings.HasSuffix(rel, ".md") }

// startTracking writes the seed files, then starts a watcher on the root. A
// nil track predicate starts a watcher that does not track renames.
func startTracking(t *testing.T, track func(string) bool, seed map[string]string) (string, *collector, *Watcher) {
	t.Helper()
	root := t.TempDir()
	// Resolve symlinks so paths reported by the OS match the paths we build.
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	for rel, content := range seed {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	c := newCollector()
	w, err := NewWithOptions(root, nil, Options{TrackRenames: track})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Start(context.Background(), c.onEvent); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Close() }) //nolint:errcheck // test cleanup
	return root, c, w
}

// settle waits long enough for every debounced event of a change to arrive.
func settle(c *collector) []Info {
	time.Sleep(10 * debounceWindow)
	return c.snapshot()
}

func renamesIn(events []Info) []Info {
	var out []Info
	for _, e := range events {
		if e.Action == ActionRename {
			out = append(out, e)
		}
	}
	return out
}

func hasEvent(events []Info, action, rel string) bool {
	for _, e := range events {
		if e.Action == action && e.RelPath == rel {
			return true
		}
	}
	return false
}

func mustRename(t *testing.T, root, oldRel, newRel string) {
	t.Helper()
	if err := os.Rename(filepath.Join(root, filepath.FromSlash(oldRel)), filepath.Join(root, filepath.FromSlash(newRel))); err != nil {
		t.Fatal(err)
	}
}

func TestRenameIsCorrelatedIntoOneEvent(t *testing.T) {
	root, c, _ := startTracking(t, trackMarkdown, map[string]string{"old.md": "content\n"})

	mustRename(t, root, "old.md", "new.md")
	events := settle(c)

	renames := renamesIn(events)
	if len(renames) != 1 {
		t.Fatalf("want 1 rename, got %d in %+v", len(renames), events)
	}
	r := renames[0]
	if r.OldRelPath != "old.md" || r.RelPath != "new.md" {
		t.Fatalf("rename = %+v", r)
	}
	if r.OldPath != filepath.Join(root, "old.md") || r.Path != filepath.Join(root, "new.md") {
		t.Fatalf("rename absolute paths = %+v", r)
	}
}

// Consumers that read only create / modify / delete must see exactly what
// they saw before rename tracking existed.
func TestRenameStillDeliversDeleteAndCreate(t *testing.T) {
	root, c, _ := startTracking(t, trackMarkdown, map[string]string{"old.md": "content\n"})

	mustRename(t, root, "old.md", "new.md")
	events := settle(c)

	if !hasEvent(events, ActionDelete, "old.md") || !hasEvent(events, ActionCreate, "new.md") {
		t.Fatalf("delete+create pair missing: %+v", events)
	}
}

func TestRenameOfFileCreatedWhileWatching(t *testing.T) {
	root, c, _ := startTracking(t, trackMarkdown, nil)
	if err := os.WriteFile(filepath.Join(root, "fresh.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	settle(c)

	mustRename(t, root, "fresh.md", "moved.md")
	renames := renamesIn(settle(c))

	if len(renames) != 1 || renames[0].OldRelPath != "fresh.md" || renames[0].RelPath != "moved.md" {
		t.Fatalf("renames = %+v", renames)
	}
}

func TestDirectoryRenameCorrelatesEachFile(t *testing.T) {
	root, c, _ := startTracking(t, trackMarkdown, map[string]string{
		"docs/a.md":      "a\n",
		"docs/sub/b.md":  "bb\n",
		"docs/other.txt": "t\n",
	})

	mustRename(t, root, "docs", "notes")
	renames := renamesIn(settle(c))

	got := map[string]string{}
	for _, r := range renames {
		got[r.OldRelPath] = r.RelPath
	}
	want := map[string]string{"docs/a.md": "notes/a.md", "docs/sub/b.md": "notes/sub/b.md"}
	if len(got) != len(want) {
		t.Fatalf("renames = %+v, want %+v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("renames = %+v, want %+v", got, want)
		}
	}
}

func TestDeleteThenUnrelatedCreateIsNotARename(t *testing.T) {
	root, c, _ := startTracking(t, trackMarkdown, map[string]string{"gone.md": "same size\n"})

	if err := os.Remove(filepath.Join(root, "gone.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "born.md"), []byte("same size\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	events := settle(c)

	if renames := renamesIn(events); len(renames) != 0 {
		t.Fatalf("unrelated delete and create were paired: %+v", renames)
	}
}

func TestEditInPlaceIsNotARename(t *testing.T) {
	root, c, _ := startTracking(t, trackMarkdown, map[string]string{"doc.md": "one\n"})

	// The save pattern of an editor that writes a sibling and renames it over
	// the original.
	tmp := filepath.Join(root, "doc.md.tmp")
	if err := os.WriteFile(tmp, []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, filepath.Join(root, "doc.md")); err != nil {
		t.Fatal(err)
	}
	events := settle(c)

	if renames := renamesIn(events); len(renames) != 0 {
		t.Fatalf("atomic save reported as rename: %+v", renames)
	}
}

func TestUntrackedFilesAreNotCorrelated(t *testing.T) {
	root, c, _ := startTracking(t, trackMarkdown, map[string]string{"data.txt": "x\n"})

	mustRename(t, root, "data.txt", "moved.txt")
	events := settle(c)

	if renames := renamesIn(events); len(renames) != 0 {
		t.Fatalf("untracked file reported as rename: %+v", renames)
	}
}

// With tracking off the watcher keeps no per-file state at all.
func TestRenameTrackingOffKeepsNoState(t *testing.T) {
	root, c, w := startTracking(t, nil, map[string]string{"old.md": "content\n"})
	if w.renames != nil {
		t.Fatal("tracker allocated although TrackRenames is nil")
	}

	mustRename(t, root, "old.md", "new.md")
	events := settle(c)

	if renames := renamesIn(events); len(renames) != 0 {
		t.Fatalf("rename delivered with tracking off: %+v", renames)
	}
	if !hasEvent(events, ActionDelete, "old.md") || !hasEvent(events, ActionCreate, "new.md") {
		t.Fatalf("delete+create pair missing: %+v", events)
	}
}

func TestTrackerIndexesOnlyTrackedFiles(t *testing.T) {
	_, _, w := startTracking(t, trackMarkdown, map[string]string{
		"a.md":        "a\n",
		"dir/b.md":    "b\n",
		"dir/code.go": "package x\n",
		"notes.txt":   "t\n",
	})
	w.renames.mu.Lock()
	defer w.renames.mu.Unlock()
	if len(w.renames.byPath) != 2 {
		t.Fatalf("indexed %d files, want 2: %v", len(w.renames.byPath), w.renames.byPath)
	}
}

func TestTrackerForgetsUnmatchedSidesAfterWindow(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "a.md")
	if err := os.WriteFile(path, []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	tr := newRenameTracker(trackMarkdown)
	clock := time.Now()
	tr.now = func() time.Time { return clock }
	tr.seed(path, info)

	tr.removed(path, func(p string) string { return filepath.Base(p) })
	clock = clock.Add(renameWindow + time.Second)

	// The same file reappearing after the window is a new file, not a rename.
	if pair, ok := tr.created(filepath.Join(root, "b.md"), "b.md", info); ok {
		t.Fatalf("stale removal was matched: %+v", pair)
	}
	if len(tr.gone) != 0 {
		t.Fatalf("stale removal still held: %v", tr.gone)
	}
}

// silentSource is an event source that reports no changes, only the errors a
// test sends it. It stands in for a source whose events were all dropped.
type silentSource struct {
	events chan fsnotify.Event
	errs   chan error
}

func (s *silentSource) Add(string) error              { return nil }
func (s *silentSource) Events() <-chan fsnotify.Event { return s.events }
func (s *silentSource) Errors() <-chan error          { return s.errs }
func (s *silentSource) Recursive() bool               { return true }
func (s *silentSource) Close() error                  { return nil }

// trackedPaths returns the root-relative paths the tracker holds.
func trackedPaths(w *Watcher) []string {
	w.renames.mu.Lock()
	defer w.renames.mu.Unlock()
	var out []string
	for p := range w.renames.byPath {
		out = append(out, w.rel(p))
	}
	slices.Sort(out)
	return out
}

// TestDroppedEventsResyncRenameTracking proves that when the source reports
// it dropped events, the tracker rebuilds from disk: a file created in the
// gap is tracked and a file removed in the gap is forgotten, though no event
// arrived for either.
func TestDroppedEventsResyncRenameTracking(t *testing.T) {
	src := &silentSource{events: make(chan fsnotify.Event), errs: make(chan error, 1)}
	prev := newEventSource
	newEventSource = func(string) (eventSource, error) { return src, nil }
	t.Cleanup(func() { newEventSource = prev })

	root, _, w := startTracking(t, trackMarkdown, map[string]string{"kept.md": "k\n", "removed.md": "r\n"})
	if got := trackedPaths(w); !slices.Equal(got, []string{"kept.md", "removed.md"}) {
		t.Fatalf("seeded %v, want kept.md and removed.md", got)
	}

	if err := os.Remove(filepath.Join(root, "removed.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "added.md"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	src.errs <- fmt.Errorf("%w under %s", errEventsDropped, root)

	deadline := time.Now().Add(5 * time.Second)
	want := []string{"added.md", "kept.md"}
	for !slices.Equal(trackedPaths(w), want) {
		if time.Now().After(deadline) {
			t.Fatalf("tracker holds %v after dropped events, want %v", trackedPaths(w), want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
