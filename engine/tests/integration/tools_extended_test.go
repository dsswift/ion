//go:build integration

package integration

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/tools"
)

// ─── Real tool execution tests ───

func TestBashToolRealEcho(t *testing.T) {
	result, err := tools.ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "echo 'integration test output'",
	}, t.TempDir())

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "integration test output") {
		t.Errorf("expected output, got: %s", result.Content)
	}
}

func TestBashToolExitCode(t *testing.T) {
	result, err := tools.ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "exit 1",
	}, t.TempDir())

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	// Non-zero exit should be reported as error.
	if !result.IsError {
		t.Error("expected IsError=true for non-zero exit")
	}
}

func TestReadToolWithOffset(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "offset.txt")
	content := "line 1\nline 2\nline 3\nline 4\nline 5\n"
	os.WriteFile(filePath, []byte(content), 0644)

	result, err := tools.ExecuteTool(context.Background(), "Read", map[string]any{
		"file_path": filePath,
		"offset":    3,
		"limit":     2,
	}, dir)

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "line 3") {
		t.Errorf("expected 'line 3' with offset, got: %s", result.Content)
	}
}

func TestWriteToolCreatesSubdirs(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "sub", "deep", "file.txt")

	result, err := tools.ExecuteTool(context.Background(), "Write", map[string]any{
		"file_path": filePath,
		"content":   "nested file content",
	}, dir)

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != "nested file content" {
		t.Errorf("got %q, want %q", string(data), "nested file content")
	}
}

func TestEditToolReplaceAll(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "replace-all.txt")
	os.WriteFile(filePath, []byte("foo bar foo baz foo\n"), 0644)

	result, err := tools.ExecuteTool(context.Background(), "Edit", map[string]any{
		"file_path":   filePath,
		"old_string":  "foo",
		"new_string":  "qux",
		"replace_all": true,
	}, dir)

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	data, _ := os.ReadFile(filePath)
	content := string(data)
	if strings.Contains(content, "foo") {
		t.Errorf("expected all 'foo' to be replaced, got: %s", content)
	}
	if !strings.Contains(content, "qux") {
		t.Errorf("expected 'qux', got: %s", content)
	}
}

func TestGrepToolWithGlob(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.go"), []byte("package main\nfunc hello() {}\n"), 0644)
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("func hello()\n"), 0644)

	result, err := tools.ExecuteTool(context.Background(), "Grep", map[string]any{
		"pattern": "func hello",
		"path":    dir,
		"glob":    "*.go",
	}, dir)

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	// Should find match in .go file only.
	if !strings.Contains(result.Content, "a.go") {
		t.Errorf("expected a.go in results: %s", result.Content)
	}
}

func TestGlobToolRecursive(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "a", "b"), 0755)
	os.WriteFile(filepath.Join(dir, "top.ts"), []byte(""), 0644)
	os.WriteFile(filepath.Join(dir, "a", "mid.ts"), []byte(""), 0644)
	os.WriteFile(filepath.Join(dir, "a", "b", "deep.ts"), []byte(""), 0644)
	os.WriteFile(filepath.Join(dir, "skip.go"), []byte(""), 0644)

	result, err := tools.ExecuteTool(context.Background(), "Glob", map[string]any{
		"pattern": "**/*.ts",
		"path":    dir,
	}, dir)

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	if !strings.Contains(result.Content, ".ts") {
		t.Errorf("expected .ts files: %s", result.Content)
	}
	if strings.Contains(result.Content, "skip.go") {
		t.Errorf("should not include .go files: %s", result.Content)
	}
}

func TestReadToolBinaryDetection(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "binary.bin")
	// Write some binary content.
	os.WriteFile(filePath, []byte{0x00, 0x01, 0x02, 0xff, 0xfe}, 0644)

	result, err := tools.ExecuteTool(context.Background(), "Read", map[string]any{
		"file_path": filePath,
	}, dir)

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	// Should either succeed with some representation or report error.
	// The important thing is it does not crash.
	_ = result
}

func TestEditToolNonexistentFile(t *testing.T) {
	dir := t.TempDir()

	result, err := tools.ExecuteTool(context.Background(), "Edit", map[string]any{
		"file_path":  filepath.Join(dir, "nonexistent.txt"),
		"old_string": "foo",
		"new_string": "bar",
	}, dir)

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if !result.IsError {
		t.Error("expected IsError=true for editing nonexistent file")
	}
}

func TestBashToolWorkingDirectory(t *testing.T) {
	dir := t.TempDir()

	result, err := tools.ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "pwd",
	}, dir)

	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	// Output should contain the temp dir path.
	if !strings.Contains(result.Content, dir) {
		t.Errorf("expected working dir %q in output: %s", dir, result.Content)
	}
}
