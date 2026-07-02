package context

import (
	"os"
	"path/filepath"
	"testing"
)

// nestedTestCfg returns an IonPreset-equivalent config with home roots off, so
// nested-walk tests are isolated from the developer's real ~/.ion.
func nestedTestCfg(claudeCompat bool) WalkerConfig {
	cfg := IonPreset()
	cfg.ClaudeCompat = claudeCompat
	cfg.IncludeHomeRoots = false
	return cfg
}

func TestWalkNestedContextDirs_FileTargetUnderCwd(t *testing.T) {
	cwd := t.TempDir()
	desktop := filepath.Join(cwd, "desktop")
	src := filepath.Join(desktop, "src")
	os.MkdirAll(src, 0o755)
	os.WriteFile(filepath.Join(cwd, "AGENTS.md"), []byte("root agents"), 0o644)
	os.WriteFile(filepath.Join(desktop, "AGENTS.md"), []byte("desktop agents"), 0o644)

	target := filepath.Join(src, "foo.ts")
	os.WriteFile(target, []byte("// code"), 0o644)

	results := WalkNestedContextDirs(cwd, target, nestedTestCfg(false))

	if !hasPath(results, filepath.Join(desktop, "AGENTS.md")) {
		t.Errorf("expected desktop/AGENTS.md discovered, got %v", paths(results))
	}
	// The root AGENTS.md is the eager walk's job — nested must NOT return it.
	if hasPath(results, filepath.Join(cwd, "AGENTS.md")) {
		t.Errorf("nested walk must not return cwd/AGENTS.md, got %v", paths(results))
	}
	for _, r := range results {
		if r.Source != "nested" {
			t.Errorf("source = %q, want nested", r.Source)
		}
	}
}

func TestWalkNestedContextDirs_ClaudeGated(t *testing.T) {
	cwd := t.TempDir()
	sub := filepath.Join(cwd, "sub")
	os.MkdirAll(sub, 0o755)
	os.WriteFile(filepath.Join(sub, "CLAUDE.md"), []byte("claude nested"), 0o644)
	target := filepath.Join(sub, "x.go")
	os.WriteFile(target, []byte("x"), 0o644)

	off := WalkNestedContextDirs(cwd, target, nestedTestCfg(false))
	if hasPath(off, filepath.Join(sub, "CLAUDE.md")) {
		t.Error("claudeCompat=false: nested CLAUDE.md must not be discovered")
	}

	on := WalkNestedContextDirs(cwd, target, nestedTestCfg(true))
	if !hasPath(on, filepath.Join(sub, "CLAUDE.md")) {
		t.Error("claudeCompat=true: nested CLAUDE.md must be discovered")
	}
}

func TestWalkNestedContextDirs_DirectoryTarget(t *testing.T) {
	cwd := t.TempDir()
	engine := filepath.Join(cwd, "engine")
	os.MkdirAll(engine, 0o755)
	os.WriteFile(filepath.Join(engine, "AGENTS.md"), []byte("engine agents"), 0o644)

	// Target is the directory itself (Grep/Glob path=cwd/engine).
	results := WalkNestedContextDirs(cwd, engine, nestedTestCfg(false))
	if !hasPath(results, filepath.Join(engine, "AGENTS.md")) {
		t.Errorf("expected engine/AGENTS.md for directory target, got %v", paths(results))
	}
}

func TestWalkNestedContextDirs_TargetOutsideCwd(t *testing.T) {
	cwd := t.TempDir()
	other := t.TempDir() // sibling temp dir, not under cwd
	os.WriteFile(filepath.Join(other, "AGENTS.md"), []byte("nope"), 0o644)
	target := filepath.Join(other, "foo.txt")
	os.WriteFile(target, []byte("x"), 0o644)

	results := WalkNestedContextDirs(cwd, target, nestedTestCfg(false))
	if len(results) != 0 {
		t.Errorf("expected no results for target outside cwd, got %v", paths(results))
	}
}

func TestWalkNestedContextDirs_TargetEqualsCwd(t *testing.T) {
	cwd := t.TempDir()
	os.WriteFile(filepath.Join(cwd, "AGENTS.md"), []byte("root"), 0o644)

	// Target dir == cwd → nothing (eager's job).
	results := WalkNestedContextDirs(cwd, cwd, nestedTestCfg(false))
	if len(results) != 0 {
		t.Errorf("expected no results when target dir == cwd, got %v", paths(results))
	}
}

func TestWalkNestedContextDirs_ChainOrderShallowestFirst(t *testing.T) {
	cwd := t.TempDir()
	a := filepath.Join(cwd, "a")
	b := filepath.Join(a, "b")
	os.MkdirAll(b, 0o755)
	os.WriteFile(filepath.Join(a, "AGENTS.md"), []byte("a"), 0o644)
	os.WriteFile(filepath.Join(b, "AGENTS.md"), []byte("b"), 0o644)
	target := filepath.Join(b, "f.go")
	os.WriteFile(target, []byte("x"), 0o644)

	results := WalkNestedContextDirs(cwd, target, nestedTestCfg(false))
	if len(results) != 2 {
		t.Fatalf("expected 2 nested files, got %d: %v", len(results), paths(results))
	}
	// a/AGENTS.md (shallower) must come before b/AGENTS.md (deeper).
	if results[0].Path != filepath.Join(a, "AGENTS.md") {
		t.Errorf("expected a/AGENTS.md first, got %q", results[0].Path)
	}
	if results[1].Path != filepath.Join(b, "AGENTS.md") {
		t.Errorf("expected b/AGENTS.md second, got %q", results[1].Path)
	}
}

func hasPath(results []DiscoveredContext, target string) bool {
	for _, r := range results {
		if r.Path == target {
			return true
		}
	}
	return false
}

func paths(results []DiscoveredContext) []string {
	out := make([]string, 0, len(results))
	for _, r := range results {
		out = append(out, r.Path)
	}
	return out
}
