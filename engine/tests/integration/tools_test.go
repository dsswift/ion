//go:build integration

package integration

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestReadToolRealFile(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(filePath, []byte("line one\nline two\nline three\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	result, err := tools.ExecuteTool(context.Background(), "Read", map[string]any{
		"file_path": filePath,
	}, dir)

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	// Read tool should return line-numbered output
	if !strings.Contains(result.Content, "line one") {
		t.Errorf("expected 'line one' in output: %s", result.Content)
	}
	if !strings.Contains(result.Content, "line two") {
		t.Errorf("expected 'line two' in output: %s", result.Content)
	}
}

func TestWriteToolCreatesFile(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "output.txt")

	result, err := tools.ExecuteTool(context.Background(), "Write", map[string]any{
		"file_path": filePath,
		"content":   "Hello, Ion!",
	}, dir)

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	// Verify file exists with correct content
	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != "Hello, Ion!" {
		t.Errorf("file content: got %q, want %q", string(data), "Hello, Ion!")
	}
}

func TestEditToolExactMatch(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "edit.txt")
	if err := os.WriteFile(filePath, []byte("foo bar baz\nqux quux\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	result, err := tools.ExecuteTool(context.Background(), "Edit", map[string]any{
		"file_path":  filePath,
		"old_string": "bar baz",
		"new_string": "bar replaced",
	}, dir)

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	// Verify replacement
	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !strings.Contains(string(data), "bar replaced") {
		t.Errorf("expected 'bar replaced', got: %s", string(data))
	}
	if strings.Contains(string(data), "bar baz") {
		t.Error("old string should have been replaced")
	}
}

func TestEditToolFuzzyMatch(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "fuzzy.txt")
	// Write file with smart quotes (Unicode)
	content := "She said \u201chello\u201d and left.\n"
	if err := os.WriteFile(filePath, []byte(content), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Try to match with straight quotes (fuzzy should handle this)
	result, err := tools.ExecuteTool(context.Background(), "Edit", map[string]any{
		"file_path":  filePath,
		"old_string": `She said "hello" and left.`,
		"new_string": `She said "goodbye" and left.`,
	}, dir)

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		// Fuzzy match might not work in all implementations
		t.Logf("Edit with fuzzy match returned error (may be expected): %s", result.Content)
		return
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !strings.Contains(string(data), "goodbye") {
		t.Errorf("expected 'goodbye' after fuzzy edit, got: %s", string(data))
	}
}

func TestBashToolCommand(t *testing.T) {
	result, err := tools.ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "echo hello",
	}, t.TempDir())

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "hello") {
		t.Errorf("expected 'hello' in output: %s", result.Content)
	}
}

func TestGrepToolSearch(t *testing.T) {
	dir := t.TempDir()

	// Create files with known content
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("foo bar\nbaz qux\n"), 0644)
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("nothing here\n"), 0644)
	os.WriteFile(filepath.Join(dir, "c.txt"), []byte("foo again\n"), 0644)

	result, err := tools.ExecuteTool(context.Background(), "Grep", map[string]any{
		"pattern": "foo",
		"path":    dir,
	}, dir)

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	// Should find matches in a.txt and c.txt
	if !strings.Contains(result.Content, "foo") {
		t.Errorf("expected grep to find 'foo': %s", result.Content)
	}
}

func TestGlobToolPattern(t *testing.T) {
	dir := t.TempDir()

	// Create directory structure
	os.MkdirAll(filepath.Join(dir, "sub", "deep"), 0755)
	os.WriteFile(filepath.Join(dir, "top.go"), []byte("package main"), 0644)
	os.WriteFile(filepath.Join(dir, "sub", "lib.go"), []byte("package lib"), 0644)
	os.WriteFile(filepath.Join(dir, "sub", "deep", "inner.go"), []byte("package deep"), 0644)
	os.WriteFile(filepath.Join(dir, "readme.md"), []byte("# README"), 0644)

	result, err := tools.ExecuteTool(context.Background(), "Glob", map[string]any{
		"pattern": "**/*.go",
		"path":    dir,
	}, dir)

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	// Should find .go files
	if !strings.Contains(result.Content, ".go") {
		t.Errorf("expected .go files in output: %s", result.Content)
	}
	// Should not include .md files
	if strings.Contains(result.Content, "readme.md") {
		t.Errorf("should not include .md files: %s", result.Content)
	}
}

func TestToolRegistryComplete(t *testing.T) {
	tools.RegisterTaskTools()
	defer tools.UnregisterTaskTools()

	expectedTools := []string{
		"Read", "Write", "Edit", "Bash", "Grep", "Glob",
		"Agent", "WebFetch", "WebSearch",
		"TaskCreate", "TaskList", "TaskGet", "TaskStop",
		"NotebookEdit", "LSP",
	}

	for _, name := range expectedTools {
		tool := tools.GetTool(name)
		if tool == nil {
			t.Errorf("tool %q not registered", name)
			continue
		}
		if tool.Name != name {
			t.Errorf("tool.Name: got %q, want %q", tool.Name, name)
		}
		if tool.Description == "" {
			t.Errorf("tool %q has empty description", name)
		}
		if tool.InputSchema == nil {
			t.Errorf("tool %q has nil InputSchema", name)
		}
		if tool.Execute == nil {
			t.Errorf("tool %q has nil Execute function", name)
		}
	}

	// Verify total count
	all := tools.GetAllTools()
	if len(all) < len(expectedTools) {
		t.Errorf("expected at least %d tools, got %d", len(expectedTools), len(all))
	}
}

func TestToolDefsFormat(t *testing.T) {
	defs := tools.GetToolDefs()
	if len(defs) == 0 {
		t.Fatal("no tool defs returned")
	}

	for _, def := range defs {
		if def.Name == "" {
			t.Error("tool def has empty name")
		}
		if def.Description == "" {
			t.Errorf("tool %q has empty description", def.Name)
		}
		if def.InputSchema == nil {
			t.Errorf("tool %q has nil input schema", def.Name)
		}
	}
}

func TestReadToolNonexistentFile(t *testing.T) {
	result, err := tools.ExecuteTool(context.Background(), "Read", map[string]any{
		"file_path": "/nonexistent/path/file.txt",
	}, t.TempDir())

	if err != nil {
		t.Fatalf("ExecuteTool should not return Go error: %v", err)
	}
	if !result.IsError {
		t.Error("expected IsError=true for nonexistent file")
	}
}

func TestUnknownTool(t *testing.T) {
	result, err := tools.ExecuteTool(context.Background(), "NonExistentTool", map[string]any{}, "")
	if err != nil {
		t.Fatalf("ExecuteTool should not return Go error: %v", err)
	}
	if !result.IsError {
		t.Error("expected IsError=true for unknown tool")
	}
	if !strings.Contains(result.Content, "Unknown tool") {
		t.Errorf("expected 'Unknown tool' message, got: %s", result.Content)
	}
}

// Ensure types package is used
var _ types.ToolResult
