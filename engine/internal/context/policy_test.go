package context

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func boolPtr(b bool) *bool { return &b }

// TestResolvePolicyCascade verifies the four-level tri-state merge: each level
// overrides only the fields it explicitly sets, and higher levels win.
func TestResolvePolicyCascade(t *testing.T) {
	cases := []struct {
		name        string
		perDispatch *types.DispatchContextConfig
		session     *types.DispatchContextConfig
		engine      *types.DispatchContextConfig
		engineCompat bool
		wantGlobal  bool
		wantProject bool
		wantCompat  bool
	}{
		{
			name:        "all_nil_builtin_defaults_on",
			engineCompat: false,
			wantGlobal:  true,
			wantProject: true,
			wantCompat:  false,
		},
		{
			name:         "engine_compat_seeds_default",
			engineCompat: true,
			wantGlobal:   true,
			wantProject:  true,
			wantCompat:   true,
		},
		{
			name:        "engine_config_disables_global",
			engine:      &types.DispatchContextConfig{IncludeGlobalContext: boolPtr(false)},
			wantGlobal:  false,
			wantProject: true,
			wantCompat:  false,
		},
		{
			name:        "session_overrides_engine",
			engine:      &types.DispatchContextConfig{IncludeGlobalContext: boolPtr(false)},
			session:     &types.DispatchContextConfig{IncludeGlobalContext: boolPtr(true)},
			wantGlobal:  true,
			wantProject: true,
			wantCompat:  false,
		},
		{
			name:        "perdispatch_overrides_session_and_engine",
			engine:      &types.DispatchContextConfig{IncludeProjectContext: boolPtr(true)},
			session:     &types.DispatchContextConfig{IncludeProjectContext: boolPtr(true)},
			perDispatch: &types.DispatchContextConfig{IncludeProjectContext: boolPtr(false)},
			wantGlobal:  true,
			wantProject: false,
			wantCompat:  false,
		},
		{
			name:        "independent_fields_merge_across_levels",
			engine:      &types.DispatchContextConfig{IncludeGlobalContext: boolPtr(false)},
			session:     &types.DispatchContextConfig{IncludeProjectContext: boolPtr(false)},
			perDispatch: &types.DispatchContextConfig{ClaudeCompat: boolPtr(true)},
			wantGlobal:  false,
			wantProject: false,
			wantCompat:  true,
		},
		{
			name:         "perdispatch_compat_overrides_engine_seed",
			engineCompat: true,
			perDispatch:  &types.DispatchContextConfig{ClaudeCompat: boolPtr(false)},
			wantGlobal:   true,
			wantProject:  true,
			wantCompat:   false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolvePolicy(tc.perDispatch, tc.session, tc.engine, tc.engineCompat)
			if got.IncludeGlobalContext != tc.wantGlobal {
				t.Errorf("IncludeGlobalContext = %v, want %v", got.IncludeGlobalContext, tc.wantGlobal)
			}
			if got.IncludeProjectContext != tc.wantProject {
				t.Errorf("IncludeProjectContext = %v, want %v", got.IncludeProjectContext, tc.wantProject)
			}
			if got.ClaudeCompat != tc.wantCompat {
				t.Errorf("ClaudeCompat = %v, want %v", got.ClaudeCompat, tc.wantCompat)
			}
		})
	}
}

// TestBuildContextPromptProjectWalk verifies a project AGENTS.md at the cwd is
// discovered and formatted with the `# Context from` framing.
func TestBuildContextPromptProjectWalk(t *testing.T) {
	dir := t.TempDir()
	agentsPath := filepath.Join(dir, "AGENTS.md")
	if err := os.WriteFile(agentsPath, []byte("PROJECT GROUNDING CONTENT"), 0o644); err != nil {
		t.Fatal(err)
	}

	policy := ResolvedPolicy{IncludeGlobalContext: false, IncludeProjectContext: true}
	content, files := BuildContextPrompt(dir, "test", policy)

	if !strings.Contains(content, "# Context from "+agentsPath) {
		t.Errorf("expected content to reference %q, got:\n%s", agentsPath, content)
	}
	if !strings.Contains(content, "PROJECT GROUNDING CONTENT") {
		t.Errorf("expected project grounding content, got:\n%s", content)
	}
	if len(files) != 1 {
		t.Errorf("expected 1 discovered file, got %d", len(files))
	}
}

// TestBuildContextPromptProjectSuppressed verifies includeProjectContext=false
// suppresses the cwd walk entirely — including the implicit cwd fallback — so a
// project AGENTS.md is NOT picked up.
func TestBuildContextPromptProjectSuppressed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("SHOULD NOT APPEAR"), 0o644); err != nil {
		t.Fatal(err)
	}

	policy := ResolvedPolicy{IncludeGlobalContext: false, IncludeProjectContext: false}
	content, files := BuildContextPrompt(dir, "test", policy)

	if content != "" {
		t.Errorf("expected empty content when both layers off, got:\n%s", content)
	}
	if len(files) != 0 {
		t.Errorf("expected 0 discovered files, got %d", len(files))
	}
}

// TestBuildContextPromptEmptyCwd verifies an empty cwd short-circuits.
func TestBuildContextPromptEmptyCwd(t *testing.T) {
	content, files := BuildContextPrompt("", "test", ResolvedPolicy{IncludeProjectContext: true})
	if content != "" || files != nil {
		t.Errorf("expected empty result for empty cwd, got content=%q files=%v", content, files)
	}
}

// TestWalkContextFilesSuppressProjectRoots is a focused unit test on the walker
// flag that decouples project suppression from the implicit cwd fallback.
func TestWalkContextFilesSuppressProjectRoots(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("CWD FILE"), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := IonPreset()
	cfg.IncludeHomeRoots = false
	cfg.SuppressProjectRoots = true
	files := WalkContextFiles(dir, cfg)
	if len(files) != 0 {
		t.Errorf("SuppressProjectRoots should skip the cwd fallback; got %d files", len(files))
	}
}
