package extension

import (
	"os"
	"path/filepath"
	"testing"
)

// TestWalkContextFilesForExtension verifies the read-only walker exposed to
// extensions via the ext/walk_context_files RPC returns the discovered project
// AGENTS.md with its path and content, and honors the includeProject flag.
func TestWalkContextFilesForExtension(t *testing.T) {
	dir := t.TempDir()
	agentsPath := filepath.Join(dir, "AGENTS.md")
	if err := os.WriteFile(agentsPath, []byte("EXTENSION WALK CONTENT"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("project_walk_returns_file", func(t *testing.T) {
		off := false
		files := walkContextFilesForExtension(WalkContextFilesRequest{
			Cwd:           dir,
			IncludeGlobal: &off, // isolate the project layer from home roots
		})
		if len(files) != 1 {
			t.Fatalf("expected 1 file, got %d: %+v", len(files), files)
		}
		if files[0].Path != agentsPath {
			t.Errorf("path = %q, want %q", files[0].Path, agentsPath)
		}
		if files[0].Content != "EXTENSION WALK CONTENT" {
			t.Errorf("content = %q, want %q", files[0].Content, "EXTENSION WALK CONTENT")
		}
		if files[0].Source != "project" {
			t.Errorf("source = %q, want project", files[0].Source)
		}
	})

	t.Run("project_off_suppresses_walk", func(t *testing.T) {
		off := false
		files := walkContextFilesForExtension(WalkContextFilesRequest{
			Cwd:            dir,
			IncludeGlobal:  &off,
			IncludeProject: &off,
		})
		if len(files) != 0 {
			t.Fatalf("expected 0 files when project layer off, got %d", len(files))
		}
	})

	t.Run("empty_cwd_returns_nil", func(t *testing.T) {
		if files := walkContextFilesForExtension(WalkContextFilesRequest{}); files != nil {
			t.Fatalf("expected nil for empty cwd, got %+v", files)
		}
	})
}

// TestHostDispatchContextDefaults verifies the session-scoped setter/getter
// round-trips a policy (level 3 of the cascade).
func TestHostDispatchContextDefaults(t *testing.T) {
	h := NewHost()
	if h.GetDispatchContextDefaults() != nil {
		t.Fatal("expected nil default before set")
	}
	on := true
	off := false
	h.SetDispatchContextDefaults(&ContextPolicy{
		IncludeGlobalContext:  &off,
		IncludeProjectContext: &on,
	})
	got := h.GetDispatchContextDefaults()
	if got == nil || got.IncludeGlobalContext == nil || *got.IncludeGlobalContext != false {
		t.Fatalf("expected IncludeGlobalContext=false, got %+v", got)
	}
	if got.IncludeProjectContext == nil || *got.IncludeProjectContext != true {
		t.Fatalf("expected IncludeProjectContext=true, got %+v", got)
	}
	h.SetDispatchContextDefaults(nil)
	if h.GetDispatchContextDefaults() != nil {
		t.Fatal("expected nil default after clear")
	}
}
