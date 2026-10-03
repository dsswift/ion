package session

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// linkRecorder collects the rename and propagation hooks a session fires.
type linkRecorder struct {
	mu      sync.Mutex
	renames []extension.WorkspaceFileRenamedInfo
	reports []extension.WikiLinkPropagationReport
	changes []extension.WorkspaceFileChangedInfo
}

func (r *linkRecorder) group() *extension.ExtensionGroup {
	host := extension.NewHost()
	host.SDK().On(extension.HookWorkspaceFileRenamed, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		r.mu.Lock()
		r.renames = append(r.renames, payload.(extension.WorkspaceFileRenamedInfo))
		r.mu.Unlock()
		return nil, nil
	})
	host.SDK().On(extension.HookWikiLinksPropagated, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		r.mu.Lock()
		r.reports = append(r.reports, payload.(extension.WikiLinkPropagationReport))
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

func (r *linkRecorder) counts() (renames, reports int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.renames), len(r.reports)
}

// linkWorkspace creates a workspace holding a document and one that links to
// it. The root is symlink-resolved so reported paths match built ones.
func linkWorkspace(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	for rel, content := range map[string]string{
		"old-name.md": "# target\n",
		"index.md":    "See [[old-name]] and [[old-name|the label]].\n",
	} {
		if err := os.WriteFile(filepath.Join(root, rel), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// watchSession starts a session on root and attaches a recording extension
// group. StartSession itself starts the workspace watcher.
func watchSession(t *testing.T, mgr *Manager, key, root string) *linkRecorder {
	t.Helper()
	cfg := defaultConfig()
	cfg.WorkingDirectory = root
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	rec := &linkRecorder{}
	group := rec.group()
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.extGroup = group
	mgr.mu.Unlock()

	mgr.ensureWorkspaceWatcher(s, key)
	mgr.mu.RLock()
	running := s.fsWatcherRelease != nil
	mgr.mu.RUnlock()
	if !running {
		t.Fatal("session has no workspace watcher")
	}
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

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func boolPointer(v bool) *bool { return &v }

func TestRenamePropagatesLinksAndReports(t *testing.T) {
	root := linkWorkspace(t)
	mgr := NewManager(newMockBackend())
	events := newEventCollector(mgr)
	rec := watchSession(t, mgr, "links", root)

	if err := os.Rename(filepath.Join(root, "old-name.md"), filepath.Join(root, "new-name.md")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "propagation event", func() bool { return len(events.byType("engine_wiki_links_propagated")) == 1 })

	if got := readFile(t, filepath.Join(root, "index.md")); got != "See [[new-name]] and [[new-name|the label]].\n" {
		t.Fatalf("index.md = %q", got)
	}

	report := events.byType("engine_wiki_links_propagated")[0].event.WikiLinksPropagated
	if report == nil {
		t.Fatal("event carries no report")
	}
	wantRenames := []types.WikiLinkRename{{OldPath: "old-name.md", NewPath: "new-name.md"}}
	if report.Root != root || len(report.Renames) != 1 || report.Renames[0] != wantRenames[0] {
		t.Fatalf("report root=%q renames=%+v", report.Root, report.Renames)
	}
	if report.RewriteCount != 2 || len(report.Files) != 1 || report.Files[0].Path != "index.md" {
		t.Fatalf("report = %+v", report)
	}

	waitFor(t, "rename and propagation hooks", func() bool {
		renames, reports := rec.counts()
		return renames == 1 && reports == 1
	})
	rec.mu.Lock()
	rename := rec.renames[0]
	hookReport := rec.reports[0]
	rec.mu.Unlock()
	want := extension.WorkspaceFileRenamedInfo{
		OldPath: filepath.Join(root, "old-name.md"), OldRelPath: "old-name.md",
		NewPath: filepath.Join(root, "new-name.md"), NewRelPath: "new-name.md",
	}
	if rename != want {
		t.Fatalf("rename hook = %+v, want %+v", rename, want)
	}
	if hookReport.RewriteCount != 2 {
		t.Fatalf("hook report = %+v", hookReport)
	}

	// The rename still reaches consumers of the three original actions.
	waitFor(t, "delete and create for the renamed file", func() bool {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		var deleted, created bool
		for _, c := range rec.changes {
			deleted = deleted || (c.Action == "delete" && c.RelPath == "old-name.md")
			created = created || (c.Action == "create" && c.RelPath == "new-name.md")
		}
		return deleted && created
	})
}

// Wiki-link maintenance is an engine feature: a session with no extension
// loaded still has its renames observed and its links rewritten.
func TestRenamePropagatesWithoutExtensions(t *testing.T) {
	root := linkWorkspace(t)
	mgr := NewManager(newMockBackend())
	events := newEventCollector(mgr)
	cfg := defaultConfig()
	cfg.WorkingDirectory = root
	if _, err := mgr.StartSession("bare", cfg); err != nil {
		t.Fatal(err)
	}
	defer mgr.StopSession("bare") //nolint:errcheck // test cleanup

	if err := os.Rename(filepath.Join(root, "old-name.md"), filepath.Join(root, "new-name.md")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "propagation event", func() bool { return len(events.byType("engine_wiki_links_propagated")) == 1 })

	if got := readFile(t, filepath.Join(root, "index.md")); got != "See [[new-name]] and [[new-name|the label]].\n" {
		t.Fatalf("index.md = %q", got)
	}
}

// With wiki links off and no extension loaded, nothing consumes filesystem
// events, so no watcher runs at all.
func TestNoWatcherWithoutConsumers(t *testing.T) {
	mgr := NewManager(newMockBackend())
	mgr.SetConfig(&types.EngineRuntimeConfig{WikiLinks: &types.WikiLinksConfig{Enabled: boolPointer(false)}})
	cfg := defaultConfig()
	cfg.WorkingDirectory = linkWorkspace(t)
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

// Sessions sharing a workspace share one watcher. The links are rewritten
// once, and each session is told.
func TestRenamePropagatesOncePerWorkspace(t *testing.T) {
	root := linkWorkspace(t)
	mgr := NewManager(newMockBackend())
	events := newEventCollector(mgr)
	watchSession(t, mgr, "first", root)
	watchSession(t, mgr, "second", root)

	if err := os.Rename(filepath.Join(root, "old-name.md"), filepath.Join(root, "new-name.md")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "one event per session", func() bool { return len(events.byType("engine_wiki_links_propagated")) == 2 })
	time.Sleep(3 * propagationSettle)

	got := events.byType("engine_wiki_links_propagated")
	if len(got) != 2 {
		t.Fatalf("got %d events, want one per session", len(got))
	}
	keys := map[string]bool{got[0].key: true, got[1].key: true}
	if !keys["first"] || !keys["second"] {
		t.Fatalf("events went to %v", keys)
	}
	for _, e := range got {
		if e.event.WikiLinksPropagated.RewriteCount != 2 {
			t.Fatalf("session %s report = %+v", e.key, e.event.WikiLinksPropagated)
		}
	}
}

func TestPropagationOffStillReportsRename(t *testing.T) {
	root := linkWorkspace(t)
	mgr := NewManager(newMockBackend())
	mgr.SetConfig(&types.EngineRuntimeConfig{WikiLinks: &types.WikiLinksConfig{PropagateOnRename: boolPointer(false)}})
	events := newEventCollector(mgr)
	rec := watchSession(t, mgr, "detect-only", root)
	before := readFile(t, filepath.Join(root, "index.md"))

	if err := os.Rename(filepath.Join(root, "old-name.md"), filepath.Join(root, "new-name.md")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "rename hook", func() bool { renames, _ := rec.counts(); return renames == 1 })
	time.Sleep(3 * propagationSettle)

	if got := readFile(t, filepath.Join(root, "index.md")); got != before {
		t.Fatalf("links were rewritten with propagation off: %q", got)
	}
	if n := len(events.byType("engine_wiki_links_propagated")); n != 0 {
		t.Fatalf("got %d propagation events with propagation off", n)
	}
}

func TestWikiLinksDisabledDoesNothing(t *testing.T) {
	root := linkWorkspace(t)
	mgr := NewManager(newMockBackend())
	mgr.SetConfig(&types.EngineRuntimeConfig{WikiLinks: &types.WikiLinksConfig{Enabled: boolPointer(false)}})
	events := newEventCollector(mgr)
	rec := watchSession(t, mgr, "disabled", root)
	before := readFile(t, filepath.Join(root, "index.md"))

	// The watcher exists for the extension, but holds no rename worker.
	mgr.watchers.mu.Lock()
	for _, entry := range mgr.watchers.entries {
		if entry.renames != nil {
			t.Error("rename worker allocated although wiki links are disabled")
		}
	}
	mgr.watchers.mu.Unlock()

	if err := os.Rename(filepath.Join(root, "old-name.md"), filepath.Join(root, "new-name.md")); err != nil {
		t.Fatal(err)
	}
	// The delete and create still arrive; wait for them so the quiet check
	// below is not vacuous.
	waitFor(t, "create for the new path", func() bool {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		for _, c := range rec.changes {
			if c.Action == "create" && c.RelPath == "new-name.md" {
				return true
			}
		}
		return false
	})
	time.Sleep(3 * propagationSettle)

	if renames, reports := rec.counts(); renames != 0 || reports != 0 {
		t.Fatalf("disabled subsystem fired hooks: renames=%d reports=%d", renames, reports)
	}
	if got := readFile(t, filepath.Join(root, "index.md")); got != before {
		t.Fatalf("links were rewritten while disabled: %q", got)
	}
	if n := len(events.byType("engine_wiki_links_propagated")); n != 0 {
		t.Fatalf("got %d propagation events while disabled", n)
	}
	if _, err := mgr.ScanWikiLinks("disabled"); !errors.Is(err, ErrWikiLinkScanDisabled) {
		t.Fatalf("scan error = %v, want ErrWikiLinkScanDisabled", err)
	}
}

func TestScanWikiLinksReportsBrokenLinks(t *testing.T) {
	root := linkWorkspace(t)
	if err := os.WriteFile(filepath.Join(root, "stale.md"), []byte("[[renamed-long-ago]]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Ignored by the default workspace ignore list, so never scanned.
	if err := os.MkdirAll(filepath.Join(root, "node_modules", "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "node_modules", "pkg", "readme.md"), []byte("[[nowhere]]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(newMockBackend())
	cfg := defaultConfig()
	cfg.WorkingDirectory = root
	if _, err := mgr.StartSession("scan", cfg); err != nil {
		t.Fatal(err)
	}
	defer mgr.StopSession("scan") //nolint:errcheck // test cleanup

	report, err := mgr.ScanWikiLinks("scan")
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Broken) != 1 || report.Broken[0].Path != "stale.md" || report.Broken[0].Target != "renamed-long-ago" {
		t.Fatalf("broken = %+v", report.Broken)
	}
	if report.DocumentsScanned != 3 {
		t.Fatalf("documentsScanned = %d, want 3", report.DocumentsScanned)
	}
}

func TestScanWikiLinksRefusedWhenScanOff(t *testing.T) {
	root := linkWorkspace(t)
	mgr := NewManager(newMockBackend())
	mgr.SetConfig(&types.EngineRuntimeConfig{WikiLinks: &types.WikiLinksConfig{IntegrityScan: boolPointer(false)}})
	cfg := defaultConfig()
	cfg.WorkingDirectory = root
	if _, err := mgr.StartSession("scan-off", cfg); err != nil {
		t.Fatal(err)
	}
	defer mgr.StopSession("scan-off") //nolint:errcheck // test cleanup

	if _, err := mgr.ScanWikiLinks("scan-off"); !errors.Is(err, ErrWikiLinkScanDisabled) {
		t.Fatalf("scan error = %v, want ErrWikiLinkScanDisabled", err)
	}
}

func TestScanWikiLinksUnknownSession(t *testing.T) {
	mgr := NewManager(newMockBackend())
	if _, err := mgr.ScanWikiLinks("nope"); err == nil {
		t.Fatal("scan of an unknown session must fail")
	}
}
