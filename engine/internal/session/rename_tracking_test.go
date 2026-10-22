package session

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// renameRecorder collects the workspace hooks a session fires.
type renameRecorder struct {
	mu      sync.Mutex
	renames []extension.WorkspaceFileRenamedInfo
	changes []extension.WorkspaceFileChangedInfo
}

func (r *renameRecorder) group() *extension.ExtensionGroup {
	host := extension.NewHost()
	host.SDK().On(extension.HookWorkspaceFileRenamed, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		r.mu.Lock()
		r.renames = append(r.renames, payload.(extension.WorkspaceFileRenamedInfo))
		r.mu.Unlock()
		return nil, nil
	})
	host.SDK().On(extension.HookWorkspaceFileChanged, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		r.mu.Lock()
		r.changes = append(r.changes, payload.(extension.WorkspaceFileChangedInfo))
		r.mu.Unlock()
		return nil, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)
	return group
}

func (r *renameRecorder) renameCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.renames)
}

func (r *renameRecorder) sawCreate(rel string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, c := range r.changes {
		if c.Action == "create" && c.RelPath == rel {
			return true
		}
	}
	return false
}

// renameWorkspace creates a workspace holding one document and one file the
// default rename extensions do not cover. The root is symlink-resolved so
// reported paths match built ones.
func renameWorkspace(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	for rel, content := range map[string]string{
		"old-name.md":  "# target\n",
		"old-name.txt": "plain\n",
	} {
		if err := os.WriteFile(filepath.Join(root, rel), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// watchSession starts a session on root and attaches a recording extension
// group, which is what makes the session run a workspace watcher.
func watchSession(t *testing.T, mgr *Manager, key, root string) *renameRecorder {
	t.Helper()
	cfg := defaultConfig()
	cfg.WorkingDirectory = root
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	rec := &renameRecorder{}
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.extGroup = rec.group()
	mgr.mu.Unlock()

	mgr.ensureWorkspaceWatcher(s, key)
	awaitWorkspaceWatcher(t, mgr, s)
	t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // test cleanup
	return rec
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func renameFile(t *testing.T, root, from, to string) {
	t.Helper()
	if err := os.Rename(filepath.Join(root, from), filepath.Join(root, to)); err != nil {
		t.Fatal(err)
	}
}

func TestRenameReachesExtensionHook(t *testing.T) {
	root := renameWorkspace(t)
	mgr := NewManager(newMockBackend())
	rec := watchSession(t, mgr, "renames", root)

	renameFile(t, root, "old-name.md", "new-name.md")
	waitFor(t, "rename hook", func() bool { return rec.renameCount() == 1 })

	rec.mu.Lock()
	defer rec.mu.Unlock()
	if got := rec.renames[0]; got.OldRelPath != "old-name.md" || got.NewRelPath != "new-name.md" {
		t.Fatalf("rename = %+v", got)
	}
}

// Only files whose extension is configured are tracked: the default covers
// markdown and not text files.
func TestRenameTrackingIsLimitedToConfiguredExtensions(t *testing.T) {
	root := renameWorkspace(t)
	mgr := NewManager(newMockBackend())
	rec := watchSession(t, mgr, "extensions", root)

	renameFile(t, root, "old-name.txt", "new-name.txt")
	renameFile(t, root, "old-name.md", "new-name.md")
	waitFor(t, "rename hook for the document", func() bool { return rec.renameCount() >= 1 })
	time.Sleep(200 * time.Millisecond)

	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.renames) != 1 || rec.renames[0].NewRelPath != "new-name.md" {
		t.Fatalf("renames = %+v, want only the document", rec.renames)
	}
}

func TestRenameExtensionsConfigTracksOtherFiles(t *testing.T) {
	root := renameWorkspace(t)
	mgr := NewManager(newMockBackend())
	mgr.SetConfig(&types.EngineRuntimeConfig{Workspace: &types.WorkspaceConfig{RenameExtensions: []string{"txt"}}})
	rec := watchSession(t, mgr, "txt", root)

	renameFile(t, root, "old-name.txt", "new-name.txt")
	waitFor(t, "rename hook", func() bool { return rec.renameCount() == 1 })
}

func TestTrackRenamesOffStillDeliversDeleteAndCreate(t *testing.T) {
	root := renameWorkspace(t)
	mgr := NewManager(newMockBackend())
	off := false
	mgr.SetConfig(&types.EngineRuntimeConfig{Workspace: &types.WorkspaceConfig{TrackRenames: &off}})
	rec := watchSession(t, mgr, "off", root)

	renameFile(t, root, "old-name.md", "new-name.md")
	// The create still arrives; wait for it so the quiet check is not vacuous.
	waitFor(t, "create for the new path", func() bool { return rec.sawCreate("new-name.md") })
	time.Sleep(200 * time.Millisecond)

	if n := rec.renameCount(); n != 0 {
		t.Fatalf("got %d rename hooks with tracking off", n)
	}
}

// Sessions sharing a workspace share one watcher, and each is told.
func TestRenameReachesEverySessionOnAWorkspace(t *testing.T) {
	root := renameWorkspace(t)
	mgr := NewManager(newMockBackend())
	first := watchSession(t, mgr, "first", root)
	second := watchSession(t, mgr, "second", root)

	renameFile(t, root, "old-name.md", "new-name.md")
	waitFor(t, "rename hook in both sessions", func() bool { return first.renameCount() == 1 && second.renameCount() == 1 })

	mgr.watchers.mu.Lock()
	defer mgr.watchers.mu.Unlock()
	if n := len(mgr.watchers.entries); n != 1 {
		t.Fatalf("%d watchers for one workspace, want 1", n)
	}
}

// With no extension loaded nothing consumes filesystem events, so no watcher
// runs.
func TestNoWatcherWithoutExtensions(t *testing.T) {
	mgr := NewManager(newMockBackend())
	cfg := defaultConfig()
	cfg.WorkingDirectory = renameWorkspace(t)
	if _, err := mgr.StartSession("idle", cfg); err != nil {
		t.Fatal(err)
	}
	defer mgr.StopSession("idle") //nolint:errcheck // test cleanup

	mgr.watchers.mu.Lock()
	defer mgr.watchers.mu.Unlock()
	if n := len(mgr.watchers.entries); n != 0 {
		t.Fatalf("%d watchers running with no consumer", n)
	}
}
