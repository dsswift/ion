package context

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWalkContextFiles(t *testing.T) {
	// Create a temp directory tree:
	// root/
	//   AGENTS.md
	//   sub/
	//     AGENTS.md
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	os.MkdirAll(sub, 0o755)
	os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("root context"), 0o644)
	os.WriteFile(filepath.Join(sub, "AGENTS.md"), []byte("sub context"), 0o644)

	results := WalkContextFiles(sub, WalkerConfig{
		AlwaysPatterns: []string{"AGENTS.md"},
		RecurseParents: true,
		Deduplication:  true,
	})

	if len(results) < 2 {
		t.Fatalf("expected at least 2 context files, got %d", len(results))
	}
	if results[0].Source != "project" {
		t.Errorf("first result source = %q, want project", results[0].Source)
	}
	if results[0].Content != "sub context" {
		t.Errorf("first result content = %q, want 'sub context'", results[0].Content)
	}
}

func TestWalkContextFilesNonRecursive(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("content"), 0o644)

	parent := filepath.Dir(root)
	os.WriteFile(filepath.Join(parent, "AGENTS.md"), []byte("parent"), 0o644)

	results := WalkContextFiles(root, WalkerConfig{
		AlwaysPatterns: []string{"AGENTS.md"},
		RecurseParents: false,
	})

	if len(results) != 1 {
		t.Fatalf("expected 1 context file, got %d", len(results))
	}
}

// TestWalkContextFiles_AgentsAlwaysLoaded pins that AGENTS.md is discovered via
// IonPreset regardless of the ClaudeCompat gate. This is the core regression
// guard: before the fix, AGENTS.md was not in the pattern set at all.
func TestWalkContextFiles_AgentsAlwaysLoaded(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	os.MkdirAll(sub, 0o755)
	os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("root agents"), 0o644)
	os.WriteFile(filepath.Join(sub, "AGENTS.md"), []byte("sub agents"), 0o644)

	for _, claudeCompat := range []bool{false, true} {
		cfg := IonPreset()
		cfg.ClaudeCompat = claudeCompat
		cfg.IncludeHomeRoots = false // isolate cwd-tree behavior from the real ~/.ion
		results := WalkContextFiles(sub, cfg)

		var paths []string
		for _, r := range results {
			paths = append(paths, r.Path)
		}
		if !containsPath(paths, filepath.Join(sub, "AGENTS.md")) {
			t.Errorf("claudeCompat=%v: expected sub/AGENTS.md to be discovered, got %v", claudeCompat, paths)
		}
		if !containsPath(paths, filepath.Join(root, "AGENTS.md")) {
			t.Errorf("claudeCompat=%v: expected root/AGENTS.md to be discovered, got %v", claudeCompat, paths)
		}
	}
}

// TestWalkContextFiles_ClaudeGated pins that CLAUDE.md is discovered ONLY when
// ClaudeCompat is true. Flipping the gate must change the result (revert-check
// for the inverted-gate bug where CLAUDE.md was loaded unconditionally).
func TestWalkContextFiles_ClaudeGated(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "CLAUDE.md"), []byte("claude context"), 0o644)

	// Gate off: CLAUDE.md must NOT be loaded.
	cfgOff := IonPreset()
	cfgOff.ClaudeCompat = false
	cfgOff.IncludeHomeRoots = false
	off := WalkContextFiles(root, cfgOff)
	if pathsContain(off, filepath.Join(root, "CLAUDE.md")) {
		t.Error("claudeCompat=false: CLAUDE.md must not be discovered")
	}

	// Gate on: CLAUDE.md must be loaded.
	cfgOn := IonPreset()
	cfgOn.ClaudeCompat = true
	cfgOn.IncludeHomeRoots = false
	on := WalkContextFiles(root, cfgOn)
	if !pathsContain(on, filepath.Join(root, "CLAUDE.md")) {
		t.Error("claudeCompat=true: CLAUDE.md must be discovered")
	}
}

// TestWalkContextFiles_HomeRoot pins that an instruction file under the home
// Ion root is discovered even when it is not an ancestor of cwd, and that the
// ~/.claude home root is gated on ClaudeCompat. The home dir is injected via
// HOME/USERPROFILE so the test never touches the developer's real ~/.ion.
func TestWalkContextFiles_HomeRoot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // Windows fallback used by os.UserHomeDir

	ionDir := filepath.Join(home, ".ion")
	claudeDir := filepath.Join(home, ".claude")
	os.MkdirAll(ionDir, 0o755)
	os.MkdirAll(claudeDir, 0o755)
	os.WriteFile(filepath.Join(ionDir, "AGENTS.md"), []byte("global agents"), 0o644)
	os.WriteFile(filepath.Join(claudeDir, "CLAUDE.md"), []byte("global claude"), 0o644)

	// cwd is a separate temp dir, not under home, so only the home root can
	// surface these files.
	cwd := t.TempDir()

	// Gate off: ~/.ion/AGENTS.md found and classified global; ~/.claude absent.
	cfgOff := IonPreset()
	cfgOff.ClaudeCompat = false
	off := WalkContextFiles(cwd, cfgOff)
	if !pathsContain(off, filepath.Join(ionDir, "AGENTS.md")) {
		t.Error("expected ~/.ion/AGENTS.md to be discovered via home root")
	}
	if pathsContain(off, filepath.Join(claudeDir, "CLAUDE.md")) {
		t.Error("claudeCompat=false: ~/.claude/CLAUDE.md must not be discovered")
	}
	for _, r := range off {
		if r.Path == filepath.Join(ionDir, "AGENTS.md") && r.Source != "global" {
			t.Errorf("~/.ion/AGENTS.md source = %q, want global", r.Source)
		}
	}

	// Gate on: ~/.claude/CLAUDE.md now discovered too.
	cfgOn := IonPreset()
	cfgOn.ClaudeCompat = true
	on := WalkContextFiles(cwd, cfgOn)
	if !pathsContain(on, filepath.Join(claudeDir, "CLAUDE.md")) {
		t.Error("claudeCompat=true: expected ~/.claude/CLAUDE.md to be discovered")
	}
}

// TestWalkContextFiles_HomeRootDedup pins that when the home Ion root is also
// an ancestor of cwd, the file is loaded exactly once.
func TestWalkContextFiles_HomeRootDedup(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	ionDir := filepath.Join(home, ".ion")
	os.MkdirAll(ionDir, 0o755)
	os.WriteFile(filepath.Join(ionDir, "AGENTS.md"), []byte("global agents"), 0o644)

	// cwd lives under ~/.ion so the recursive walk and the home root both
	// reach ~/.ion/AGENTS.md.
	cwd := filepath.Join(ionDir, "project")
	os.MkdirAll(cwd, 0o755)

	cfg := IonPreset()
	cfg.ClaudeCompat = false
	results := WalkContextFiles(cwd, cfg)

	count := 0
	for _, r := range results {
		if r.Path == filepath.Join(ionDir, "AGENTS.md") {
			count++
		}
	}
	if count != 1 {
		t.Errorf("expected ~/.ion/AGENTS.md loaded exactly once, got %d", count)
	}
}

func pathsContain(results []DiscoveredContext, target string) bool {
	for _, r := range results {
		if r.Path == target {
			return true
		}
	}
	return false
}

func containsPath(paths []string, target string) bool {
	for _, p := range paths {
		if p == target {
			return true
		}
	}
	return false
}

func TestProcessIncludes(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "included.md"), []byte("included content"), 0o644)

	content := "line1\n@included.md\nline3"
	result := ProcessIncludes(content, dir, "@", nil)

	if !strings.Contains(result, "included content") {
		t.Errorf("expected included content in result, got: %s", result)
	}
	if !strings.Contains(result, "line1") || !strings.Contains(result, "line3") {
		t.Errorf("expected surrounding lines preserved")
	}
}

func TestProcessIncludesCircular(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.md"), []byte("@b.md"), 0o644)
	os.WriteFile(filepath.Join(dir, "b.md"), []byte("@a.md"), 0o644)

	result := ProcessIncludes("@a.md", dir, "@", nil)
	if !strings.Contains(result, "circular include") {
		t.Errorf("expected circular include comment, got: %s", result)
	}
}

func TestProcessIncludesMissing(t *testing.T) {
	dir := t.TempDir()
	result := ProcessIncludes("@nonexistent.md", dir, "@", nil)
	if !strings.Contains(result, "include not found") {
		t.Errorf("expected 'include not found' comment, got: %s", result)
	}
}

func TestPresets(t *testing.T) {
	preset := IonPreset()

	// Ion-native patterns are always present (loaded regardless of the gate).
	if !containsPath(preset.AlwaysPatterns, "AGENTS.md") {
		t.Errorf("IonPreset always-tier missing AGENTS.md: %v", preset.AlwaysPatterns)
	}
	if !containsPath(preset.AlwaysPatterns, "ION.md") {
		t.Errorf("IonPreset always-tier missing ION.md: %v", preset.AlwaysPatterns)
	}
	// Claude-compat patterns live in the gated tier, NOT the always-tier.
	if containsPath(preset.AlwaysPatterns, "CLAUDE.md") {
		t.Error("IonPreset always-tier must not contain CLAUDE.md (it is gated)")
	}
	if !containsPath(preset.CompatPatterns, "CLAUDE.md") {
		t.Errorf("IonPreset compat-tier missing CLAUDE.md: %v", preset.CompatPatterns)
	}
	if !preset.RecurseParents {
		t.Error("expected RecurseParents to be true")
	}
	if !preset.IncludeHomeRoots {
		t.Error("expected IncludeHomeRoots to be true")
	}
	// The preset defaults the gate off; callers opt in.
	if preset.ClaudeCompat {
		t.Error("expected IonPreset to default ClaudeCompat=false")
	}
}
