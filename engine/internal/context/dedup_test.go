package context

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func compatCfg() WalkerConfig {
	return WalkerConfig{
		AlwaysPatterns: []string{"AGENTS.md"},
		CompatPatterns: []string{"CLAUDE.md"},
		ClaudeCompat:   true,
		Deduplication:  true,
	}
}

// The Ion repo shape: AGENTS.md is the source and CLAUDE.md a symlink to it.
// With Claude compatibility on, both names match, and the instructions must
// still be injected once.
func TestWalkContextFiles_SymlinkInjectedOnce(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "AGENTS.md"), "shared rules")
	if err := os.Symlink("AGENTS.md", filepath.Join(dir, "CLAUDE.md")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	var events []DiscoverEvent
	cfg := compatCfg()
	cfg.Hooks.OnDiscover = func(ev DiscoverEvent) bool { events = append(events, ev); return false }

	got := WalkContextFiles(dir, cfg)
	if len(got) != 1 || got[0].Path != filepath.Join(dir, "AGENTS.md") {
		t.Fatalf("want AGENTS.md once, got %+v", got)
	}
	if len(events) != 2 {
		t.Fatalf("discover should fire for the duplicate too; got %d events", len(events))
	}
	dup := events[1]
	if dup.Path != filepath.Join(dir, "CLAUDE.md") || dup.DuplicateOf != filepath.Join(dir, "AGENTS.md") || dup.DuplicateReason != DuplicateSymlink {
		t.Fatalf("duplicate event wrong: %+v", dup)
	}
}

func TestWalkContextFiles_IdenticalContentInjectedOnce(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "AGENTS.md"), "same bytes")
	writeFile(t, filepath.Join(dir, "CLAUDE.md"), "same bytes")

	var dupReason string
	cfg := compatCfg()
	cfg.Hooks.OnDiscover = func(ev DiscoverEvent) bool {
		if ev.DuplicateOf != "" {
			dupReason = ev.DuplicateReason
		}
		return false
	}
	got := WalkContextFiles(dir, cfg)
	if len(got) != 1 {
		t.Fatalf("want 1 file, got %d", len(got))
	}
	if dupReason != DuplicateContent {
		t.Fatalf("reason = %q, want %q", dupReason, DuplicateContent)
	}
}

func TestWalkContextFiles_DifferentContentStacks(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "AGENTS.md"), "agents rules")
	writeFile(t, filepath.Join(dir, "CLAUDE.md"), "claude rules")
	if got := WalkContextFiles(dir, compatCfg()); len(got) != 2 {
		t.Fatalf("want both files, got %d", len(got))
	}
}

func TestWalkContextFiles_DiscoverHookRejects(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "AGENTS.md"), "rules")
	cfg := compatCfg()
	cfg.Hooks.OnDiscover = func(DiscoverEvent) bool { return true }
	if got := WalkContextFiles(dir, cfg); len(got) != 0 {
		t.Fatalf("rejected file was loaded: %+v", got)
	}
}

// A rejected file is still recorded, so its symlink cannot bring it back.
func TestWalkContextFiles_RejectedFileNotReadmittedBySymlink(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "AGENTS.md"), "rules")
	if err := os.Symlink("AGENTS.md", filepath.Join(dir, "CLAUDE.md")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	cfg := compatCfg()
	cfg.Hooks.OnDiscover = func(ev DiscoverEvent) bool { return strings.HasSuffix(ev.Path, "AGENTS.md") }
	if got := WalkContextFiles(dir, cfg); len(got) != 0 {
		t.Fatalf("symlink readmitted a rejected file: %+v", got)
	}
}

func TestWalkContextFiles_LoadHookReplacesAndRejects(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "AGENTS.md"), "original")
	writeFile(t, filepath.Join(dir, "CLAUDE.md"), "drop me")
	cfg := compatCfg()
	cfg.Hooks.OnLoad = func(path, content, _ string) (string, bool) {
		if strings.HasSuffix(path, "CLAUDE.md") {
			return "", true
		}
		return "rewritten", false
	}
	got := WalkContextFiles(dir, cfg)
	if len(got) != 1 || got[0].Content != "rewritten" {
		t.Fatalf("want one rewritten file, got %+v", got)
	}
}

func TestProcessIncludes_DepthCap(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "b.md"), "B\n@c.md")
	writeFile(t, filepath.Join(dir, "c.md"), "C\n@d.md")
	writeFile(t, filepath.Join(dir, "d.md"), "D")

	out := ProcessIncludes("A\n@b.md", dir, "@", nil, 2)
	if !strings.Contains(out, "B") || !strings.Contains(out, "C") {
		t.Fatalf("hops within the cap were not followed: %q", out)
	}
	if strings.Contains(out, "\nD") || !strings.Contains(out, "<!-- max include depth reached: d.md -->") {
		t.Fatalf("hop past the cap was not cut: %q", out)
	}

	full := ProcessIncludes("A\n@b.md", dir, "@", nil, 0)
	if !strings.Contains(full, "D") {
		t.Fatalf("default cap should follow three hops: %q", full)
	}
}

func TestWalkContextFiles_IncludeMaxDepthFromConfig(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "AGENTS.md"), "@one.md")
	writeFile(t, filepath.Join(dir, "one.md"), "ONE\n@two.md")
	writeFile(t, filepath.Join(dir, "two.md"), "TWO")
	cfg := WalkerConfig{AlwaysPatterns: []string{"AGENTS.md"}, IncludeDirective: "@", IncludeMaxDepth: 1, Deduplication: true}
	got := WalkContextFiles(dir, cfg)
	if len(got) != 1 || strings.Contains(got[0].Content, "TWO") || !strings.Contains(got[0].Content, "max include depth reached: two.md") {
		t.Fatalf("depth 1 should stop at one.md: %+v", got)
	}
}

func TestIonPreset_AgentsDirPattern(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, ".agents", "AGENTS.md"), "dotted")
	cfg := IonPreset()
	cfg.IncludeHomeRoots = false
	cfg.RecurseParents = false
	got := WalkContextFiles(dir, cfg)
	if len(got) != 1 || got[0].Content != "dotted" {
		t.Fatalf(".agents/AGENTS.md not discovered: %+v", got)
	}
}
