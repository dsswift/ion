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
	//   CLAUDE.md
	//   sub/
	//     CLAUDE.md
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	os.MkdirAll(sub, 0o755)
	os.WriteFile(filepath.Join(root, "CLAUDE.md"), []byte("root context"), 0o644)
	os.WriteFile(filepath.Join(sub, "CLAUDE.md"), []byte("sub context"), 0o644)

	results := WalkContextFiles(sub, WalkerConfig{
		FilePatterns:   []string{"CLAUDE.md"},
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
	os.WriteFile(filepath.Join(root, "CLAUDE.md"), []byte("content"), 0o644)

	parent := filepath.Dir(root)
	os.WriteFile(filepath.Join(parent, "CLAUDE.md"), []byte("parent"), 0o644)

	results := WalkContextFiles(root, WalkerConfig{
		FilePatterns:   []string{"CLAUDE.md"},
		RecurseParents: false,
	})

	if len(results) != 1 {
		t.Fatalf("expected 1 context file, got %d", len(results))
	}
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
	tests := []struct {
		name   string
		preset WalkerConfig
	}{
		{"ClaudeCode", ClaudeCodePreset()},
		{"PiMono", PiMonoPreset()},
		{"Ion", IonPreset()},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if len(tt.preset.FilePatterns) == 0 {
				t.Error("expected non-empty FilePatterns")
			}
			if !tt.preset.RecurseParents {
				t.Error("expected RecurseParents to be true")
			}
		})
	}
}
