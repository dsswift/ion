//go:build darwin && cgo

package watcher

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/dsswift/ion/engine/internal/procres"
	"github.com/fsnotify/fsnotify"
)

// writeTree creates dirs directories under root holding perDir files each.
func writeTree(t *testing.T, root string, dirs, perDir int) {
	t.Helper()
	for d := range dirs {
		dir := filepath.Join(root, fmt.Sprintf("d%03d", d))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for f := range perDir {
			if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%03d.txt", f)), []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// TestFSEventsWatcherHoldsNoDescriptorPerFile pins the reason macOS uses
// FSEvents: watching a tree must not cost the engine one descriptor per file.
// Under fsnotify's kqueue backend this tree holds about 3,000 descriptors for
// as long as the watcher runs.
func TestFSEventsWatcherHoldsNoDescriptorPerFile(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, 30, 100)

	before := procres.ReadDescriptors().Open
	w, err := New(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Start(context.Background(), newCollector().onEvent); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Close() }) //nolint:errcheck // test cleanup
	during := procres.ReadDescriptors().Open

	if before < 0 || during < 0 {
		t.Fatal("descriptor count unavailable on this platform")
	}
	if grew := during - before; grew > 20 {
		t.Fatalf("watching 3,000 files opened %d descriptors, want a handful", grew)
	}
}

// TestFSEventsReportsDeepChangesAfterStart proves one root stream covers
// directories that existed before Start, at any depth, with no per-directory
// attach.
func TestFSEventsReportsDeepChangesAfterStart(t *testing.T) {
	root := t.TempDir()
	deep := filepath.Join(root, "a", "b", "c")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	c := newCollector()
	w, err := New(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Start(context.Background(), c.onEvent); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Close() }) //nolint:errcheck // test cleanup

	if err := os.WriteFile(filepath.Join(deep, "new.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// The directories made just before Start can surface as events too, so
	// look for the file rather than taking the first event.
	if events := settle(c); !slices.ContainsFunc(events, func(e Info) bool { return e.RelPath == "a/b/c/new.txt" }) {
		t.Fatalf("no event for a/b/c/new.txt; got %+v", events)
	}
}

// TestFSEventsDirectoryMovedInReportsItsFiles covers the case FSEvents
// reports as a single event: a directory moved into the tree arrives as one
// rename of the directory, with nothing for the files inside it.
func TestFSEventsDirectoryMovedInReportsItsFiles(t *testing.T) {
	outside := t.TempDir()
	staged := filepath.Join(outside, "pkg")
	if err := os.MkdirAll(filepath.Join(staged, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"one.txt", "sub/two.txt"} {
		if err := os.WriteFile(filepath.Join(staged, rel), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	root, c, _, cleanup := setupWatcher(t, nil)
	defer cleanup()
	if err := os.Rename(staged, filepath.Join(root, "pkg")); err != nil {
		t.Fatal(err)
	}

	events := settle(c)
	for _, rel := range []string{"pkg", "pkg/one.txt", "pkg/sub/two.txt"} {
		if !hasEvent(events, ActionCreate, rel) {
			t.Errorf("no create for %s; got %+v", rel, events)
		}
	}
}

// TestFSEventsSymlinkedRootKeepsItsName proves events name paths under the
// root as the caller gave it, though FSEvents reports the resolved path.
func TestFSEventsSymlinkedRootKeepsItsName(t *testing.T) {
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	c := newCollector()
	w, err := New(link, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Start(context.Background(), c.onEvent); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Close() }) //nolint:errcheck // test cleanup

	if err := os.WriteFile(filepath.Join(target, "f.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(link, "f.txt")
	if events := settle(c); !slices.ContainsFunc(events, func(e Info) bool { return e.Path == want && e.RelPath == "f.txt" }) {
		t.Fatalf("no event with Path %s and RelPath f.txt; got %+v", want, events)
	}
}

// TestFSEventOps pins how coalesced FSEvents flags become ordered ops.
func TestFSEventOps(t *testing.T) {
	cases := []struct {
		name   string
		flags  uint32
		exists bool
		want   []fsnotify.Op
	}{
		{"created", fsItemCreated, true, []fsnotify.Op{fsnotify.Create}},
		{"created and written", fsItemCreated | fsItemModified, true, []fsnotify.Op{fsnotify.Create, fsnotify.Write}},
		{"written", fsItemModified, true, []fsnotify.Op{fsnotify.Write}},
		{"renamed into place", fsItemRenamed, true, []fsnotify.Op{fsnotify.Create}},
		{"renamed away", fsItemRenamed, false, []fsnotify.Op{fsnotify.Remove}},
		{"removed", fsItemRemoved, false, []fsnotify.Op{fsnotify.Remove}},
		{"created then removed", fsItemCreated | fsItemRemoved, false, []fsnotify.Op{fsnotify.Remove}},
		{"removed then recreated", fsItemRemoved | fsItemCreated, true, []fsnotify.Op{fsnotify.Create}},
		{"metadata only", fsItemMetadata, true, []fsnotify.Op{fsnotify.Chmod}},
		{"written with metadata", fsItemModified | fsItemMetadata, true, []fsnotify.Op{fsnotify.Write}},
		{"no item change", fsHistoryDone, true, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := fseventOps(tc.flags, tc.exists); !slices.Equal(got, tc.want) {
				t.Fatalf("fseventOps(0x%x, %v) = %v, want %v", tc.flags, tc.exists, got, tc.want)
			}
		})
	}
}
