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

// workspaceRecorder is a thread-safe sink that hook handlers append into.
type workspaceRecorder struct {
	mu     sync.Mutex
	events []extension.WorkspaceFileChangedInfo
}

func (r *workspaceRecorder) record(info extension.WorkspaceFileChangedInfo) {
	r.mu.Lock()
	r.events = append(r.events, info)
	r.mu.Unlock()
}

func (r *workspaceRecorder) snapshot() []extension.WorkspaceFileChangedInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]extension.WorkspaceFileChangedInfo, len(r.events))
	copy(out, r.events)
	return out
}

// newWorkspaceGroup builds an ExtensionGroup with a single host that records
// every workspace_file_changed hook fire into the given recorder.
func newWorkspaceGroup(rec *workspaceRecorder) *extension.ExtensionGroup {
	host := extension.NewHost()
	host.SDK().On(extension.HookWorkspaceFileChanged, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		rec.record(payload.(extension.WorkspaceFileChangedInfo))
		return nil, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)
	return group
}

// startSessionWithWatcher creates a session bound to a temp WorkingDirectory,
// attaches a recording extension group, and starts the workspace watcher.
// The session is fully manager-owned so the standard stop path tears the
// watcher down. Returns the manager, session key, recorder, and the cwd.
//
// The test deliberately constructs the watcher via startWorkspaceWatcher
// (the same call StartSession uses) rather than going through the full
// StartSession path -- the full path requires either a real loaded
// extension or extensive mocking of helpers/backend. The behavior we care
// about (watcher fan-out into the extension group's hook callback) is
// identical either way.
func startSessionWithWatcher(t *testing.T, ignores []string) (*Manager, string, *workspaceRecorder, string) {
	t.Helper()
	cwd := t.TempDir()
	mb := newMockBackend()
	mgr := NewManager(mb)

	cfg := defaultConfig()
	cfg.WorkingDirectory = cwd
	cfg.WorkspaceWatchIgnore = ignores

	key := "ws-watch-test"
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	rec := &workspaceRecorder{}
	group := newWorkspaceGroup(rec)

	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.extGroup = group
	mgr.mu.Unlock()

	release := mgr.startWorkspaceWatcher(s, key, group)
	if release == nil {
		t.Fatal("startWorkspaceWatcher returned nil")
	}
	mgr.mu.Lock()
	s.fsWatcherRelease = release
	mgr.mu.Unlock()

	// Allow fsnotify to settle before tests start writing.
	time.Sleep(20 * time.Millisecond)
	return mgr, key, rec, cwd
}

func TestWorkspaceWatcher_FiresOnFileWrite(t *testing.T) {
	mgr, key, rec, cwd := startSessionWithWatcher(t, nil)
	defer mgr.StopSession(key)

	target := filepath.Join(cwd, "notes.md")
	if err := os.WriteFile(target, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Poll for the event up to 500ms (debounce + fsnotify settle).
	deadline := time.Now().Add(500 * time.Millisecond)
	var events []extension.WorkspaceFileChangedInfo
	for time.Now().Before(deadline) {
		events = rec.snapshot()
		if len(events) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(events) == 0 {
		t.Fatal("no workspace_file_changed event fired for file write")
	}
	first := events[0]
	if first.RelPath != "notes.md" {
		t.Errorf("RelPath = %q, want %q", first.RelPath, "notes.md")
	}
	if first.Path != target {
		t.Errorf("Path = %q, want %q", first.Path, target)
	}
	// Action depends on platform; both create and modify are acceptable
	// for a brand-new file with content.
	if first.Action != "create" && first.Action != "modify" {
		t.Errorf("Action = %q, want create or modify", first.Action)
	}
}

func TestWorkspaceWatcher_DefaultIgnoresApply(t *testing.T) {
	// Pass nil ignores -> engine defaults apply (.git/**, node_modules/**, etc.).
	mgr, key, rec, cwd := startSessionWithWatcher(t, nil)
	defer mgr.StopSession(key)

	// Writing into node_modules should NOT fire.
	nm := filepath.Join(cwd, "node_modules", "pkg")
	if err := os.MkdirAll(nm, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nm, "index.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Writing a regular file SHOULD fire -- we use it as a positive control
	// so the test isn't satisfied by a watcher that silently missed everything.
	if err := os.WriteFile(filepath.Join(cwd, "README.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(500 * time.Millisecond)
	gotControl := false
	for time.Now().Before(deadline) {
		for _, e := range rec.snapshot() {
			if e.RelPath == "README.md" {
				gotControl = true
			}
		}
		if gotControl {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !gotControl {
		t.Fatal("control event for README.md never fired")
	}

	// Quiet period: ensure no node_modules event arrives even after the
	// debounce window settles past the control event.
	time.Sleep(150 * time.Millisecond)
	for _, e := range rec.snapshot() {
		if filepath.ToSlash(e.RelPath) == "node_modules/pkg/index.js" {
			t.Errorf("ignored path fired an event: %+v", e)
		}
	}
}

func TestWorkspaceWatcher_HarnessOverrideReplacesDefaults(t *testing.T) {
	// Empty override means defaults; we want a non-empty override that
	// excludes ".git" and includes node_modules.
	ignores := []string{"custom_ignore/**"}
	mgr, key, rec, cwd := startSessionWithWatcher(t, ignores)
	defer mgr.StopSession(key)

	// node_modules is NOT in our override -> events SHOULD fire.
	nm := filepath.Join(cwd, "node_modules")
	if err := os.MkdirAll(nm, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nm, "x.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// custom_ignore IS in our override -> events should NOT fire.
	ci := filepath.Join(cwd, "custom_ignore")
	if err := os.MkdirAll(ci, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ci, "x.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(500 * time.Millisecond)
	gotNM := false
	for time.Now().Before(deadline) {
		for _, e := range rec.snapshot() {
			if filepath.ToSlash(e.RelPath) == "node_modules/x.js" {
				gotNM = true
			}
		}
		if gotNM {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !gotNM {
		t.Errorf("override should have permitted node_modules events; got: %+v", rec.snapshot())
	}

	// Quiet check: nothing under custom_ignore.
	time.Sleep(150 * time.Millisecond)
	for _, e := range rec.snapshot() {
		if filepath.ToSlash(e.RelPath) == "custom_ignore/x.txt" {
			t.Errorf("custom_ignore path fired an event: %+v", e)
		}
	}
}

func TestResolveWatchIgnores(t *testing.T) {
	// Empty override -> defaults.
	got := resolveWatchIgnores(types.EngineConfig{})
	if len(got) != len(defaultWatchIgnores) {
		t.Errorf("default path: got %d ignores, want %d", len(got), len(defaultWatchIgnores))
	}
	// Non-empty override -> exactly the override.
	custom := []string{"a/**", "b/**"}
	got = resolveWatchIgnores(types.EngineConfig{WorkspaceWatchIgnore: custom})
	if len(got) != 2 || got[0] != "a/**" || got[1] != "b/**" {
		t.Errorf("override path: got %v, want %v", got, custom)
	}
}
