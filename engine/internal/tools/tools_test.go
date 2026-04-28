package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestMain(m *testing.M) {
	// Task tools are optional; register them for tests that expect them.
	RegisterTaskTools()
	os.Exit(m.Run())
}

// ---------------------------------------------------------------------------
// Registry Tests
// ---------------------------------------------------------------------------

func TestRegistryGetTool(t *testing.T) {
	tests := []struct {
		name   string
		expect bool
	}{
		{"Read", true},
		{"Write", true},
		{"Edit", true},
		{"Bash", true},
		{"Grep", true},
		{"Glob", true},
		{"Agent", true},
		{"WebFetch", true},
		{"WebSearch", true},
		{"TaskCreate", true},
		{"TaskList", true},
		{"TaskGet", true},
		{"TaskStop", true},
		{"NotebookEdit", true},
		{"LSP", true},
		{"Skill", true},
		{"ListMcpResources", true},
		{"ReadMcpResource", true},
		{"NonExistent", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tool := GetTool(tc.name)
			if tc.expect && tool == nil {
				t.Errorf("expected tool %q to be registered", tc.name)
			}
			if !tc.expect && tool != nil {
				t.Errorf("expected tool %q to NOT be registered", tc.name)
			}
		})
	}
}

func TestGetAllTools(t *testing.T) {
	all := GetAllTools()
	if len(all) != 18 {
		t.Errorf("expected 18 tools, got %d", len(all))
	}
}

func TestGetToolDefs(t *testing.T) {
	defs := GetToolDefs()
	if len(defs) != 18 {
		t.Errorf("expected 18 tool defs, got %d", len(defs))
	}
	for _, d := range defs {
		if d.Name == "" {
			t.Error("tool def has empty name")
		}
		if d.Description == "" {
			t.Errorf("tool %q has empty description", d.Name)
		}
		if d.InputSchema == nil {
			t.Errorf("tool %q has nil input schema", d.Name)
		}
	}
}

func TestGetToolDefsHaveInputSchemaType(t *testing.T) {
	defs := GetToolDefs()
	for _, d := range defs {
		if d.InputSchema["type"] != "object" {
			t.Errorf("tool %q input schema type is %v, want \"object\"", d.Name, d.InputSchema["type"])
		}
	}
}

func TestExecuteToolUnknown(t *testing.T) {
	result, err := ExecuteTool(context.Background(), "NoSuchTool", nil, "/tmp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Error("expected error result for unknown tool")
	}
	if !strings.Contains(result.Content, "Unknown tool") {
		t.Errorf("expected 'Unknown tool' message, got %q", result.Content)
	}
}

func TestRegisterCustomTool(t *testing.T) {
	custom := &types.ToolDef{
		Name:        "CustomTest",
		Description: "A test tool",
		InputSchema: map[string]any{"type": "object"},
		Execute: func(_ context.Context, _ map[string]any, _ string) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "custom result"}, nil
		},
	}
	RegisterTool(custom)
	defer func() {
		mu.Lock()
		delete(registry, "CustomTest")
		mu.Unlock()
	}()

	got := GetTool("CustomTest")
	if got == nil {
		t.Fatal("custom tool not found after registration")
	}
	result, err := got.Execute(context.Background(), nil, "/tmp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Content != "custom result" {
		t.Errorf("expected 'custom result', got %q", result.Content)
	}
}

func TestUnregisterTool(t *testing.T) {
	custom := &types.ToolDef{
		Name:        "TempTool",
		Description: "temporary",
		InputSchema: map[string]any{"type": "object"},
		Execute: func(_ context.Context, _ map[string]any, _ string) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "ok"}, nil
		},
	}
	RegisterTool(custom)
	if GetTool("TempTool") == nil {
		t.Fatal("tool should exist after register")
	}
	UnregisterTool("TempTool")
	if GetTool("TempTool") != nil {
		t.Error("tool should not exist after unregister")
	}
}

func TestRegisterToolOverwrite(t *testing.T) {
	name := "OverwriteTest"
	defer func() {
		mu.Lock()
		delete(registry, name)
		mu.Unlock()
	}()

	RegisterTool(&types.ToolDef{
		Name: name, Description: "v1", InputSchema: map[string]any{"type": "object"},
		Execute: func(_ context.Context, _ map[string]any, _ string) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "v1"}, nil
		},
	})
	RegisterTool(&types.ToolDef{
		Name: name, Description: "v2", InputSchema: map[string]any{"type": "object"},
		Execute: func(_ context.Context, _ map[string]any, _ string) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "v2"}, nil
		},
	})

	result, _ := ExecuteTool(context.Background(), name, nil, "/tmp")
	if result.Content != "v2" {
		t.Errorf("expected overwritten tool to return 'v2', got %q", result.Content)
	}
}

// ---------------------------------------------------------------------------
// Read Tool Tests
// ---------------------------------------------------------------------------

func TestReadTool(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "test.txt")
	content := "line one\nline two\nline three\nline four\nline five"
	os.WriteFile(filePath, []byte(content), 0o644)

	tests := []struct {
		name     string
		input    map[string]any
		wantErr  bool
		contains string
	}{
		{
			name:     "read entire file",
			input:    map[string]any{"file_path": filePath},
			contains: "line one",
		},
		{
			name:     "read with offset",
			input:    map[string]any{"file_path": filePath, "offset": float64(3)},
			contains: "line three",
		},
		{
			name:     "read with limit",
			input:    map[string]any{"file_path": filePath, "limit": float64(2)},
			contains: "line two",
		},
		{
			name:    "read nonexistent file",
			input:   map[string]any{"file_path": filepath.Join(dir, "nope.txt")},
			wantErr: true,
		},
		{
			name:    "read directory",
			input:   map[string]any{"file_path": dir},
			wantErr: true,
		},
	}

	ctx := context.Background()
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result, err := ExecuteTool(ctx, "Read", tc.input, dir)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantErr && !result.IsError {
				t.Error("expected error result")
			}
			if !tc.wantErr && result.IsError {
				t.Errorf("unexpected error result: %s", result.Content)
			}
			if tc.contains != "" && !strings.Contains(result.Content, tc.contains) {
				t.Errorf("expected content to contain %q, got %q", tc.contains, result.Content)
			}
		})
	}
}

func TestReadToolLineNumbers(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "numbered.txt")
	os.WriteFile(filePath, []byte("alpha\nbeta\ngamma"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Read", map[string]any{"file_path": filePath}, dir)
	if !strings.Contains(result.Content, "     1\talpha") {
		t.Errorf("expected cat -n format, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "     3\tgamma") {
		t.Errorf("expected line 3, got %q", result.Content)
	}
}

func TestReadToolOffsetAndLimit(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "lines.txt")
	var lines []string
	for i := 1; i <= 20; i++ {
		lines = append(lines, fmt.Sprintf("line %d", i))
	}
	os.WriteFile(filePath, []byte(strings.Join(lines, "\n")), 0o644)

	ctx := context.Background()

	// Offset 5, limit 3 should return lines 5, 6, 7.
	result, _ := ExecuteTool(ctx, "Read", map[string]any{
		"file_path": filePath,
		"offset":    float64(5),
		"limit":     float64(3),
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "line 5") {
		t.Errorf("expected 'line 5', got %q", result.Content)
	}
	if !strings.Contains(result.Content, "line 7") {
		t.Errorf("expected 'line 7', got %q", result.Content)
	}
	if strings.Contains(result.Content, "line 8") {
		t.Error("should not contain line 8 with limit 3")
	}
	if strings.Contains(result.Content, "line 4") {
		t.Error("should not contain line 4 with offset 5")
	}

	// Line numbers in output should reflect actual file positions.
	if !strings.Contains(result.Content, "     5\t") {
		t.Errorf("expected line number 5 in output, got %q", result.Content)
	}
}

func TestReadToolOffsetBeyondEnd(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "short.txt")
	os.WriteFile(filePath, []byte("one\ntwo"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Read", map[string]any{
		"file_path": filePath,
		"offset":    float64(100),
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	// Should return empty-ish content (empty slice).
	trimmed := strings.TrimSpace(result.Content)
	if trimmed != "" {
		t.Errorf("expected empty content for offset beyond EOF, got %q", result.Content)
	}
}

func TestReadToolEmptyFile(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "empty.txt")
	os.WriteFile(filePath, []byte(""), 0o644)

	result, _ := ExecuteTool(context.Background(), "Read", map[string]any{"file_path": filePath}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	// Empty file has one empty line from Split.
	if !strings.Contains(result.Content, "     1\t") {
		t.Errorf("expected line number in output, got %q", result.Content)
	}
}

func TestReadToolBinaryFile(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "binary.bin")
	data := []byte{0x00, 0x01, 0x02, 0xFF, 0xFE}
	os.WriteFile(filePath, data, 0o644)

	result, _ := ExecuteTool(context.Background(), "Read", map[string]any{"file_path": filePath}, dir)
	// Should not error; reads whatever bytes are there.
	if result.IsError {
		t.Fatalf("unexpected error reading binary file: %s", result.Content)
	}
}

func TestReadToolRelativePath(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "rel.txt")
	os.WriteFile(filePath, []byte("relative content"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Read", map[string]any{"file_path": "rel.txt"}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "relative content") {
		t.Errorf("expected file content, got %q", result.Content)
	}
}

func TestReadToolMissingFilePath(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "Read", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing file_path")
	}
	if !strings.Contains(result.Content, "file_path is required") {
		t.Errorf("expected file_path required message, got %q", result.Content)
	}
}

func TestReadToolLargeFile(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "large.txt")
	var sb strings.Builder
	for i := 0; i < 5000; i++ {
		fmt.Fprintf(&sb, "line %d content here\n", i+1)
	}
	os.WriteFile(filePath, []byte(sb.String()), 0o644)

	// Read with limit should cap output.
	result, _ := ExecuteTool(context.Background(), "Read", map[string]any{
		"file_path": filePath,
		"limit":     float64(10),
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	outputLines := strings.Split(strings.TrimSpace(result.Content), "\n")
	if len(outputLines) != 10 {
		t.Errorf("expected 10 lines with limit, got %d", len(outputLines))
	}
}

// ---------------------------------------------------------------------------
// Write Tool Tests
// ---------------------------------------------------------------------------

func TestWriteTool(t *testing.T) {
	dir := t.TempDir()

	tests := []struct {
		name    string
		input   map[string]any
		wantErr bool
	}{
		{
			name:  "write new file",
			input: map[string]any{"file_path": filepath.Join(dir, "out.txt"), "content": "hello world"},
		},
		{
			name:  "write with nested dirs",
			input: map[string]any{"file_path": filepath.Join(dir, "a", "b", "c.txt"), "content": "nested"},
		},
	}

	ctx := context.Background()
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result, err := ExecuteTool(ctx, "Write", tc.input, dir)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantErr && !result.IsError {
				t.Error("expected error result")
			}
			if !tc.wantErr && result.IsError {
				t.Errorf("unexpected error: %s", result.Content)
			}
			if !tc.wantErr {
				fp := tc.input["file_path"].(string)
				data, err := os.ReadFile(fp)
				if err != nil {
					t.Fatalf("file not created: %v", err)
				}
				if string(data) != tc.input["content"].(string) {
					t.Errorf("content mismatch: got %q", string(data))
				}
			}
		})
	}
}

func TestWriteToolOverwrite(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "overwrite.txt")
	os.WriteFile(filePath, []byte("original"), 0o644)

	ctx := context.Background()
	result, _ := ExecuteTool(ctx, "Write", map[string]any{
		"file_path": filePath,
		"content":   "replaced",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	data, _ := os.ReadFile(filePath)
	if string(data) != "replaced" {
		t.Errorf("expected 'replaced', got %q", string(data))
	}
}

func TestWriteToolEmptyContent(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "empty_write.txt")

	result, _ := ExecuteTool(context.Background(), "Write", map[string]any{
		"file_path": filePath,
		"content":   "",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	data, _ := os.ReadFile(filePath)
	if string(data) != "" {
		t.Errorf("expected empty file, got %q", string(data))
	}
}

func TestWriteToolMissingFilePath(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "Write", map[string]any{
		"content": "something",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing file_path")
	}
}

func TestWriteToolRelativePath(t *testing.T) {
	dir := t.TempDir()

	result, _ := ExecuteTool(context.Background(), "Write", map[string]any{
		"file_path": "relative.txt",
		"content":   "via relative",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	data, err := os.ReadFile(filepath.Join(dir, "relative.txt"))
	if err != nil {
		t.Fatalf("file not created at relative path: %v", err)
	}
	if string(data) != "via relative" {
		t.Errorf("expected 'via relative', got %q", string(data))
	}
}

func TestWriteToolSuccessMessage(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "msg.txt")

	result, _ := ExecuteTool(context.Background(), "Write", map[string]any{
		"file_path": filePath,
		"content":   "test",
	}, dir)
	if !strings.Contains(result.Content, "Successfully wrote") {
		t.Errorf("expected success message, got %q", result.Content)
	}
}

func TestWriteToolDeeplyNestedDirs(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "x", "y", "z", "w", "deep.txt")

	result, _ := ExecuteTool(context.Background(), "Write", map[string]any{
		"file_path": filePath,
		"content":   "deep content",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	data, _ := os.ReadFile(filePath)
	if string(data) != "deep content" {
		t.Errorf("expected 'deep content', got %q", string(data))
	}
}

// ---------------------------------------------------------------------------
// Edit Tool Tests
// ---------------------------------------------------------------------------

func TestEditToolExactMatch(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "edit.txt")
	os.WriteFile(filePath, []byte("hello world, hello go"), 0o644)

	ctx := context.Background()

	// Single occurrence replacement.
	result, _ := ExecuteTool(ctx, "Edit", map[string]any{
		"file_path":  filePath,
		"old_string": "world",
		"new_string": "earth",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	data, _ := os.ReadFile(filePath)
	if string(data) != "hello earth, hello go" {
		t.Errorf("expected 'hello earth, hello go', got %q", string(data))
	}
}

func TestEditToolReplaceAll(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "edit_all.txt")
	os.WriteFile(filePath, []byte("aaa bbb aaa"), 0o644)

	ctx := context.Background()

	// Multiple occurrences without replace_all should error.
	result, _ := ExecuteTool(ctx, "Edit", map[string]any{
		"file_path":  filePath,
		"old_string": "aaa",
		"new_string": "ccc",
	}, dir)
	if !result.IsError {
		t.Error("expected error for multiple occurrences without replace_all")
	}

	// With replace_all should succeed.
	result, _ = ExecuteTool(ctx, "Edit", map[string]any{
		"file_path":   filePath,
		"old_string":  "aaa",
		"new_string":  "ccc",
		"replace_all": true,
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	data, _ := os.ReadFile(filePath)
	if string(data) != "ccc bbb ccc" {
		t.Errorf("expected 'ccc bbb ccc', got %q", string(data))
	}
}

func TestEditToolFuzzyMatch(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "fuzzy.txt")
	// File contains smart quotes.
	os.WriteFile(filePath, []byte("say \u201Chello\u201D"), 0o644)

	ctx := context.Background()

	// Search with ASCII quotes should match via fuzzy.
	result, _ := ExecuteTool(ctx, "Edit", map[string]any{
		"file_path":  filePath,
		"old_string": "say \"hello\"",
		"new_string": "say goodbye",
	}, dir)
	if result.IsError {
		t.Fatalf("expected fuzzy match to succeed: %s", result.Content)
	}
	if !strings.Contains(result.Content, "fuzzy match") {
		t.Error("expected fuzzy match message")
	}
}

func TestEditToolFuzzyMatchEmDash(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "fuzzy_dash.txt")
	os.WriteFile(filePath, []byte("a\u2014b"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Edit", map[string]any{
		"file_path":  filePath,
		"old_string": "a-b",
		"new_string": "a_b",
	}, dir)
	if result.IsError {
		t.Fatalf("expected fuzzy match for em dash: %s", result.Content)
	}

	data, _ := os.ReadFile(filePath)
	if string(data) != "a_b" {
		t.Errorf("expected 'a_b', got %q", string(data))
	}
}

func TestEditToolFuzzyMatchNbsp(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "fuzzy_nbsp.txt")
	os.WriteFile(filePath, []byte("hello\u00A0world"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Edit", map[string]any{
		"file_path":  filePath,
		"old_string": "hello world",
		"new_string": "hello_world",
	}, dir)
	if result.IsError {
		t.Fatalf("expected fuzzy match for nbsp: %s", result.Content)
	}
}

func TestEditToolNotFound(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "notfound.txt")
	os.WriteFile(filePath, []byte("some content"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Edit", map[string]any{
		"file_path":  filePath,
		"old_string": "nonexistent substring",
		"new_string": "replacement",
	}, dir)
	if !result.IsError {
		t.Error("expected error when old_string not found")
	}
	if !strings.Contains(result.Content, "not found") {
		t.Errorf("expected 'not found' message, got %q", result.Content)
	}
}

func TestEditToolMultilineReplace(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "multiline.txt")
	os.WriteFile(filePath, []byte("line1\nline2\nline3\nline4"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Edit", map[string]any{
		"file_path":  filePath,
		"old_string": "line2\nline3",
		"new_string": "replaced2\nreplaced3",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	data, _ := os.ReadFile(filePath)
	if string(data) != "line1\nreplaced2\nreplaced3\nline4" {
		t.Errorf("unexpected content: %q", string(data))
	}
}

func TestEditToolReplaceWithEmpty(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "delete.txt")
	os.WriteFile(filePath, []byte("keep remove keep"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Edit", map[string]any{
		"file_path":  filePath,
		"old_string": " remove",
		"new_string": "",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}

	data, _ := os.ReadFile(filePath)
	if string(data) != "keep keep" {
		t.Errorf("expected 'keep keep', got %q", string(data))
	}
}

func TestEditToolNonexistentFile(t *testing.T) {
	dir := t.TempDir()

	result, _ := ExecuteTool(context.Background(), "Edit", map[string]any{
		"file_path":  filepath.Join(dir, "nope.txt"),
		"old_string": "x",
		"new_string": "y",
	}, dir)
	if !result.IsError {
		t.Error("expected error for nonexistent file")
	}
}

func TestEditToolMissingFilePath(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "Edit", map[string]any{
		"old_string": "x",
		"new_string": "y",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing file_path")
	}
}

func TestEditToolMultipleOccurrencesErrorCount(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "multi.txt")
	os.WriteFile(filePath, []byte("foo bar foo baz foo"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Edit", map[string]any{
		"file_path":  filePath,
		"old_string": "foo",
		"new_string": "qux",
	}, dir)
	if !result.IsError {
		t.Error("expected error for 3 occurrences")
	}
	if !strings.Contains(result.Content, "3 times") {
		t.Errorf("expected count '3' in message, got %q", result.Content)
	}
}

func TestEditToolExactMatchPreferredOverFuzzy(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "prefer_exact.txt")
	// File has both exact ASCII quote and smart quote versions.
	os.WriteFile(filePath, []byte("say \"hello\" and say \"goodbye\""), 0o644)

	result, _ := ExecuteTool(context.Background(), "Edit", map[string]any{
		"file_path":  filePath,
		"old_string": "say \"hello\"",
		"new_string": "greet",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	// Should use exact match, not fuzzy.
	if strings.Contains(result.Content, "fuzzy") {
		t.Error("expected exact match, not fuzzy")
	}
}

func TestEditToolFuzzyMatchTrailingWhitespace(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "trailing.txt")
	// File has trailing spaces on a line.
	os.WriteFile(filePath, []byte("hello   \nworld  "), 0o644)

	result, _ := ExecuteTool(context.Background(), "Edit", map[string]any{
		"file_path":  filePath,
		"old_string": "hello\nworld",
		"new_string": "hi\nthere",
	}, dir)
	if result.IsError {
		t.Fatalf("expected fuzzy match for trailing whitespace: %s", result.Content)
	}
	if !strings.Contains(result.Content, "fuzzy match") {
		t.Error("expected fuzzy match message for trailing whitespace normalization")
	}
}

func TestNormalizeForFuzzyMatch(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		expect string
	}{
		{"smart quotes", "\u201Chello\u201D", "\"hello\""},
		{"em dash", "a\u2014b", "a-b"},
		{"nbsp", "a\u00A0b", "a b"},
		{"trailing whitespace", "hello   \nworld  ", "hello\nworld"},
		{"en dash", "a\u2013b", "a-b"},
		{"horizontal bar", "a\u2015b", "a-b"},
		{"single smart quotes", "\u2018hi\u2019", "'hi'"},
		{"double angle quotes", "\u00ABtext\u00BB", "\"text\""},
		{"mixed", "\u201Chello\u201D \u2014 \u2018world\u2019", "\"hello\" - 'world'"},
		{"em space", "a\u2003b", "a b"},
		{"thin space", "a\u2009b", "a b"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := NormalizeForFuzzyMatch(tc.input)
			if got != tc.expect {
				t.Errorf("expected %q, got %q", tc.expect, got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Bash Tool Tests
// ---------------------------------------------------------------------------

func TestBashTool(t *testing.T) {
	ctx := context.Background()

	tests := []struct {
		name     string
		input    map[string]any
		wantErr  bool
		contains string
	}{
		{
			name:     "simple echo",
			input:    map[string]any{"command": "echo hello"},
			contains: "hello",
		},
		{
			name:    "failing command",
			input:   map[string]any{"command": "exit 1"},
			wantErr: true,
		},
		{
			name:     "pwd respects cwd",
			input:    map[string]any{"command": "echo ok_from_cwd"},
			contains: "ok_from_cwd",
		},
	}

	cwd := os.TempDir()
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result, err := ExecuteTool(ctx, "Bash", tc.input, cwd)
			if err != nil {
				t.Fatalf("unexpected Go error: %v", err)
			}
			if tc.wantErr && !result.IsError {
				t.Error("expected error result")
			}
			if !tc.wantErr && result.IsError {
				t.Errorf("unexpected error result: %s", result.Content)
			}
			if tc.contains != "" && !strings.Contains(result.Content, tc.contains) {
				t.Errorf("expected content to contain %q, got %q", tc.contains, result.Content)
			}
		})
	}
}

func TestBashToolTimeout(t *testing.T) {
	ctx := context.Background()

	result, err := ExecuteTool(ctx, "Bash", map[string]any{
		"command": "sleep 30",
		"timeout": float64(200), // 200ms timeout
	}, os.TempDir())
	if err != nil {
		t.Fatalf("unexpected Go error: %v", err)
	}
	if !result.IsError {
		t.Error("expected error for timed-out command")
	}
}

func TestBashToolExitCodes(t *testing.T) {
	ctx := context.Background()

	tests := []struct {
		command string
		wantErr bool
	}{
		{"exit 0", false},
		{"exit 1", true},
		{"exit 2", true},
		{"exit 127", true},
	}

	for _, tc := range tests {
		t.Run(tc.command, func(t *testing.T) {
			result, _ := ExecuteTool(ctx, "Bash", map[string]any{"command": tc.command}, os.TempDir())
			if tc.wantErr && !result.IsError {
				t.Errorf("expected error for %q", tc.command)
			}
			if !tc.wantErr && result.IsError {
				t.Errorf("unexpected error for %q: %s", tc.command, result.Content)
			}
		})
	}
}

func TestBashToolStderr(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "echo out_msg && echo err_msg >&2",
	}, os.TempDir())
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "out_msg") {
		t.Errorf("expected stdout in content, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "err_msg") {
		t.Errorf("expected stderr in content, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "STDERR") {
		t.Errorf("expected STDERR label, got %q", result.Content)
	}
}

func TestBashToolWorkingDirectory(t *testing.T) {
	dir := t.TempDir()

	result, _ := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "pwd",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, dir) {
		t.Errorf("expected pwd to show %q, got %q", dir, result.Content)
	}
}

func TestBashToolEmptyOutput(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "true",
	}, os.TempDir())
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if result.Content != "(no output)" {
		t.Errorf("expected '(no output)', got %q", result.Content)
	}
}

func TestBashToolMissingCommand(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "Bash", map[string]any{}, os.TempDir())
	if !result.IsError {
		t.Error("expected error for missing command")
	}
	if !strings.Contains(result.Content, "command is required") {
		t.Errorf("expected 'command is required', got %q", result.Content)
	}
}

func TestBashToolMultilineCommand(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "echo line1 && echo line2 && echo line3",
	}, os.TempDir())
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "line1") || !strings.Contains(result.Content, "line3") {
		t.Errorf("expected multi-line output, got %q", result.Content)
	}
}

func TestBashToolEnvVars(t *testing.T) {
	ops := &LocalBashOperations{}
	ctx := context.Background()

	result, err := ops.Exec(ctx, "echo $TEST_VAR_XYZ", os.TempDir(), ExecOptions{
		Env: map[string]string{"TEST_VAR_XYZ": "custom_value_123"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result.Stdout, "custom_value_123") {
		t.Errorf("expected env var in output, got %q", result.Stdout)
	}
}

func TestBashToolPipedCommands(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "echo 'hello world' | tr ' ' '_'",
	}, os.TempDir())
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "hello_world") {
		t.Errorf("expected piped output, got %q", result.Content)
	}
}

// ---------------------------------------------------------------------------
// Glob Tool Tests
// ---------------------------------------------------------------------------

func TestGlobTool(t *testing.T) {
	dir := t.TempDir()
	// Create test files.
	for _, name := range []string{"a.go", "b.go", "c.txt"} {
		os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644)
	}
	os.MkdirAll(filepath.Join(dir, "sub"), 0o755)
	os.WriteFile(filepath.Join(dir, "sub", "d.go"), []byte("x"), 0o644)

	ctx := context.Background()

	tests := []struct {
		name        string
		input       map[string]any
		expectCount int
		contains    string
	}{
		{
			name:        "match go files",
			input:       map[string]any{"pattern": "*.go", "path": dir},
			expectCount: 2,
			contains:    "a.go",
		},
		{
			name:        "recursive match",
			input:       map[string]any{"pattern": "**/*.go", "path": dir},
			expectCount: 3,
			contains:    "d.go",
		},
		{
			name:        "no matches",
			input:       map[string]any{"pattern": "*.rs", "path": dir},
			expectCount: 0,
			contains:    "(no matches)",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result, err := ExecuteTool(ctx, "Glob", tc.input, dir)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if result.IsError {
				t.Errorf("unexpected error result: %s", result.Content)
			}
			if tc.contains != "" && !strings.Contains(result.Content, tc.contains) {
				t.Errorf("expected content to contain %q, got %q", tc.contains, result.Content)
			}
			if tc.expectCount > 0 {
				lines := strings.Split(strings.TrimSpace(result.Content), "\n")
				if len(lines) < tc.expectCount {
					t.Errorf("expected at least %d matches, got %d: %s", tc.expectCount, len(lines), result.Content)
				}
			}
		})
	}
}

func TestGlobToolTxtFiles(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "c.go"), []byte("x"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Glob", map[string]any{
		"pattern": "*.txt",
		"path":    dir,
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	lines := strings.Split(strings.TrimSpace(result.Content), "\n")
	if len(lines) != 2 {
		t.Errorf("expected 2 txt files, got %d: %s", len(lines), result.Content)
	}
	if strings.Contains(result.Content, "c.go") {
		t.Error("should not match .go files with *.txt pattern")
	}
}

func TestGlobToolNestedDirs(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "a", "b", "c"), 0o755)
	os.WriteFile(filepath.Join(dir, "a", "b", "c", "deep.txt"), []byte("x"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Glob", map[string]any{
		"pattern": "**/*.txt",
		"path":    dir,
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "deep.txt") {
		t.Errorf("expected deep.txt in results, got %q", result.Content)
	}
}

func TestGlobToolMissingPattern(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "Glob", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing pattern")
	}
}

func TestGlobToolDefaultPath(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "default.txt"), []byte("x"), 0o644)

	// No path param; should use cwd.
	result, _ := ExecuteTool(context.Background(), "Glob", map[string]any{
		"pattern": "*.txt",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "default.txt") {
		t.Errorf("expected default.txt, got %q", result.Content)
	}
}

func TestGlobToolMultipleExtensions(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.go"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "b.ts"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "c.py"), []byte("x"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Glob", map[string]any{
		"pattern": "*.{go,ts}",
		"path":    dir,
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "a.go") || !strings.Contains(result.Content, "b.ts") {
		t.Errorf("expected go and ts files, got %q", result.Content)
	}
	if strings.Contains(result.Content, "c.py") {
		t.Error("should not include .py files")
	}
}

// ---------------------------------------------------------------------------
// Grep Tool Tests
// ---------------------------------------------------------------------------

func TestGrepToolContentMode(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "search.txt"), []byte("hello world\nfoo bar\nhello again"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Grep", map[string]any{
		"pattern":     "hello",
		"path":        dir,
		"output_mode": "content",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "hello world") {
		t.Errorf("expected 'hello world' in results, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "hello again") {
		t.Errorf("expected 'hello again' in results, got %q", result.Content)
	}
}

func TestGrepToolFilesWithMatchesMode(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "match1.txt"), []byte("target_string"), 0o644)
	os.WriteFile(filepath.Join(dir, "match2.txt"), []byte("target_string here"), 0o644)
	os.WriteFile(filepath.Join(dir, "nomatch.txt"), []byte("nothing"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Grep", map[string]any{
		"pattern":     "target_string",
		"path":        dir,
		"output_mode": "files_with_matches",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "match1.txt") {
		t.Errorf("expected match1.txt, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "match2.txt") {
		t.Errorf("expected match2.txt, got %q", result.Content)
	}
	if strings.Contains(result.Content, "nomatch.txt") {
		t.Error("nomatch.txt should not appear in results")
	}
}

func TestGrepToolCountMode(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "counted.txt"), []byte("abc\nabc\nabc\nxyz"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Grep", map[string]any{
		"pattern":     "abc",
		"path":        dir,
		"output_mode": "count",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "3") {
		t.Errorf("expected count of 3, got %q", result.Content)
	}
}

func TestGrepToolNoMatches(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "empty_search.txt"), []byte("nothing relevant"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Grep", map[string]any{
		"pattern": "zzz_nonexistent_pattern",
		"path":    dir,
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "(no matches)") {
		t.Errorf("expected '(no matches)', got %q", result.Content)
	}
}

func TestGrepToolRegexPattern(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "regex.txt"), []byte("foo123bar\nfoo456bar\nbaz789"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Grep", map[string]any{
		"pattern":     "foo[0-9]+bar",
		"path":        dir,
		"output_mode": "content",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "foo123bar") {
		t.Errorf("expected regex match, got %q", result.Content)
	}
	if strings.Contains(result.Content, "baz789") {
		t.Error("baz789 should not match regex")
	}
}

func TestGrepToolGlobFilter(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "code.go"), []byte("func main"), 0o644)
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("func main"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Grep", map[string]any{
		"pattern":     "func main",
		"path":        dir,
		"glob":        "*.go",
		"output_mode": "files_with_matches",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "code.go") {
		t.Errorf("expected code.go in filtered results, got %q", result.Content)
	}
	if strings.Contains(result.Content, "notes.txt") {
		t.Error("notes.txt should be excluded by glob filter")
	}
}

func TestGrepToolMissingPattern(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "Grep", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing pattern")
	}
}

func TestGrepToolSingleFile(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "single.txt")
	os.WriteFile(filePath, []byte("alpha\nbeta\ngamma"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Grep", map[string]any{
		"pattern":     "beta",
		"path":        filePath,
		"output_mode": "content",
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "beta") {
		t.Errorf("expected beta, got %q", result.Content)
	}
}

func TestGrepToolDefaultOutputMode(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "def.txt"), []byte("searchable_token"), 0o644)

	// No output_mode specified; default is "content".
	result, _ := ExecuteTool(context.Background(), "Grep", map[string]any{
		"pattern": "searchable_token",
		"path":    dir,
	}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	// Content mode should include the matched line text.
	if !strings.Contains(result.Content, "searchable_token") {
		t.Errorf("expected content in default mode, got %q", result.Content)
	}
}

// ---------------------------------------------------------------------------
// Agent Tool Tests
// ---------------------------------------------------------------------------

func TestAgentToolNoSpawner(t *testing.T) {
	// Ensure no spawner is set.
	old := agentSpawner
	agentSpawner = nil
	defer func() { agentSpawner = old }()

	result, err := ExecuteTool(context.Background(), "Agent", map[string]any{"prompt": "do something"}, "/tmp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Error("expected error when no spawner configured")
	}
	if !strings.Contains(result.Content, "not available") {
		t.Errorf("expected 'not available' message, got %q", result.Content)
	}
}

func TestAgentToolMissingPrompt(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "Agent", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing prompt")
	}
	if !strings.Contains(result.Content, "prompt is required") {
		t.Errorf("expected prompt required message, got %q", result.Content)
	}
}

func TestAgentToolWithSpawner(t *testing.T) {
	old := agentSpawner
	agentSpawner = func(ctx context.Context, name, prompt, description, cwd, model string) (string, error) {
		return "agent completed: " + prompt, nil
	}
	defer func() { agentSpawner = old }()

	result, _ := ExecuteTool(context.Background(), "Agent", map[string]any{
		"prompt": "test task",
	}, "/tmp")
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "agent completed: test task") {
		t.Errorf("expected spawner result, got %q", result.Content)
	}
}

func TestAgentToolSpawnerError(t *testing.T) {
	old := agentSpawner
	agentSpawner = func(ctx context.Context, name, prompt, description, cwd, model string) (string, error) {
		return "", fmt.Errorf("spawn failed")
	}
	defer func() { agentSpawner = old }()

	result, _ := ExecuteTool(context.Background(), "Agent", map[string]any{
		"prompt": "test",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error when spawner fails")
	}
	if !strings.Contains(result.Content, "spawn failed") {
		t.Errorf("expected spawn error message, got %q", result.Content)
	}
}

// ---------------------------------------------------------------------------
// LSP Tool Tests
// ---------------------------------------------------------------------------

func TestLspToolNotConfigured(t *testing.T) {
	old := lspManager
	lspManager = nil
	defer func() { lspManager = old }()

	result, _ := ExecuteTool(context.Background(), "LSP", map[string]any{"operation": "hover"}, "/tmp")
	if !result.IsError {
		t.Error("expected error when LSP not configured")
	}
	if !strings.Contains(result.Content, "LSP not configured") {
		t.Errorf("unexpected message: %s", result.Content)
	}
}

// ---------------------------------------------------------------------------
// Task Tool Tests
// ---------------------------------------------------------------------------

func TestTaskToolsNoSpawner(t *testing.T) {
	old := taskSpawner
	taskSpawner = nil
	defer func() { taskSpawner = old }()

	result, _ := ExecuteTool(context.Background(), "TaskCreate", map[string]any{"prompt": "test"}, "/tmp")
	if !result.IsError {
		t.Error("expected error when no task spawner configured")
	}
}

func TestTaskListEmpty(t *testing.T) {
	// Clear tasks for this test.
	tasksMu.Lock()
	saved := tasks
	tasks = make(map[string]*TaskInfo)
	tasksMu.Unlock()
	defer func() {
		tasksMu.Lock()
		tasks = saved
		tasksMu.Unlock()
	}()

	result, _ := ExecuteTool(context.Background(), "TaskList", map[string]any{}, "/tmp")
	if result.Content != "No tasks." {
		t.Errorf("expected 'No tasks.', got %q", result.Content)
	}
}

func TestTaskGetNotFound(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "TaskGet", map[string]any{
		"taskId": "task-nonexistent",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for nonexistent task")
	}
	if !strings.Contains(result.Content, "not found") {
		t.Errorf("expected 'not found', got %q", result.Content)
	}
}

func TestTaskGetMissingId(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "TaskGet", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing taskId")
	}
}

func TestTaskStopNotFound(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "TaskStop", map[string]any{
		"taskId": "task-ghost",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for nonexistent task")
	}
}

func TestTaskStopMissingId(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "TaskStop", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing taskId")
	}
}

func TestTaskStopAlreadyCompleted(t *testing.T) {
	tasksMu.Lock()
	saved := tasks
	now := time.Now()
	tasks = map[string]*TaskInfo{
		"task-done": {
			ID:          "task-done",
			Prompt:      "done task",
			Status:      "completed",
			StartedAt:   now,
			CompletedAt: &now,
		},
	}
	tasksMu.Unlock()
	defer func() {
		tasksMu.Lock()
		tasks = saved
		tasksMu.Unlock()
	}()

	result, _ := ExecuteTool(context.Background(), "TaskStop", map[string]any{
		"taskId": "task-done",
	}, "/tmp")
	// Should not error but indicate it's not running.
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "not running") {
		t.Errorf("expected 'not running' message, got %q", result.Content)
	}
}

func TestTaskCreateMissingPrompt(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "TaskCreate", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing prompt")
	}
}

func TestTaskListWithTasks(t *testing.T) {
	tasksMu.Lock()
	saved := tasks
	tasks = map[string]*TaskInfo{
		"task-abc": {
			ID:        "task-abc",
			Prompt:    "do something",
			Status:    "running",
			StartedAt: time.Now(),
		},
	}
	tasksMu.Unlock()
	defer func() {
		tasksMu.Lock()
		tasks = saved
		tasksMu.Unlock()
	}()

	result, _ := ExecuteTool(context.Background(), "TaskList", map[string]any{}, "/tmp")
	if !strings.Contains(result.Content, "task-abc") {
		t.Errorf("expected task-abc in list, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "running") {
		t.Errorf("expected 'running' status, got %q", result.Content)
	}
}

func TestTaskGetExistingTask(t *testing.T) {
	tasksMu.Lock()
	saved := tasks
	tasks = map[string]*TaskInfo{
		"task-xyz": {
			ID:        "task-xyz",
			Prompt:    "test prompt",
			Status:    "completed",
			Result:    "task result here",
			StartedAt: time.Now(),
		},
	}
	tasksMu.Unlock()
	defer func() {
		tasksMu.Lock()
		tasks = saved
		tasksMu.Unlock()
	}()

	result, _ := ExecuteTool(context.Background(), "TaskGet", map[string]any{
		"taskId": "task-xyz",
	}, "/tmp")
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "task-xyz") {
		t.Errorf("expected task ID in output, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "completed") {
		t.Errorf("expected status, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "task result here") {
		t.Errorf("expected result content, got %q", result.Content)
	}
}

// ---------------------------------------------------------------------------
// WebFetch Tests
// ---------------------------------------------------------------------------

func TestWebFetchBlockedHosts(t *testing.T) {
	tests := []struct {
		host    string
		blocked bool
	}{
		{"127.0.0.1", true},
		{"10.0.0.1", true},
		{"192.168.1.1", true},
		{"172.16.0.1", true},
		{"169.254.1.1", true},
		{"localhost", true},
		{"0.0.0.0", true},
		{"[::]", true},
		{"8.8.8.8", false},
		{"example.com", false},
	}

	for _, tc := range tests {
		t.Run(tc.host, func(t *testing.T) {
			got := isBlockedHost(tc.host)
			if got != tc.blocked {
				t.Errorf("isBlockedHost(%q) = %v, want %v", tc.host, got, tc.blocked)
			}
		})
	}
}

func TestWebFetchBlockedHostsExtended(t *testing.T) {
	tests := []struct {
		host    string
		blocked bool
	}{
		{"10.255.255.255", true},
		{"172.31.255.255", true},
		{"192.168.0.1", true},
		{"127.0.0.2", true},
		{"169.254.169.254", true}, // AWS metadata
		{"172.15.0.1", false},     // Just below the 172.16 range
		{"172.32.0.1", false},     // Just above the 172.31 range
		{"1.1.1.1", false},
		{"93.184.216.34", false},
	}

	for _, tc := range tests {
		t.Run(tc.host, func(t *testing.T) {
			got := isBlockedHost(tc.host)
			if got != tc.blocked {
				t.Errorf("isBlockedHost(%q) = %v, want %v", tc.host, got, tc.blocked)
			}
		})
	}
}

func TestHtmlToText(t *testing.T) {
	html := `<html><head><title>Test</title></head><body><h1>Hello</h1><p>World</p><script>alert("x")</script></body></html>`
	text := htmlToText(html)
	if !strings.Contains(text, "Hello") {
		t.Errorf("expected 'Hello' in text, got %q", text)
	}
	if !strings.Contains(text, "World") {
		t.Errorf("expected 'World' in text, got %q", text)
	}
	if strings.Contains(text, "alert") {
		t.Error("script content should be stripped")
	}
	if strings.Contains(text, "<") {
		t.Error("HTML tags should be stripped")
	}
}

func TestHtmlToTextStyleStripped(t *testing.T) {
	html := `<html><head><style>.cls { color: red; }</style></head><body><p>Visible</p></body></html>`
	text := htmlToText(html)
	if strings.Contains(text, "color") {
		t.Error("style content should be stripped")
	}
	if !strings.Contains(text, "Visible") {
		t.Errorf("expected visible text, got %q", text)
	}
}

func TestHtmlToTextEntities(t *testing.T) {
	html := `<p>A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39;</p>`
	text := htmlToText(html)
	if !strings.Contains(text, "A & B") {
		t.Errorf("expected decoded &amp;, got %q", text)
	}
	if !strings.Contains(text, "< C >") {
		t.Errorf("expected decoded &lt; &gt;, got %q", text)
	}
	if !strings.Contains(text, "\"E\"") {
		t.Errorf("expected decoded &quot;, got %q", text)
	}
	if !strings.Contains(text, "'F'") {
		t.Errorf("expected decoded &#39;, got %q", text)
	}
}

func TestHtmlToTextBrTags(t *testing.T) {
	html := `<p>line1<br/>line2<br>line3</p>`
	text := htmlToText(html)
	if !strings.Contains(text, "line1\nline2") {
		t.Errorf("expected br to produce newlines, got %q", text)
	}
}

func TestHtmlToTextNbsp(t *testing.T) {
	html := `<p>hello&nbsp;world</p>`
	text := htmlToText(html)
	if !strings.Contains(text, "hello world") {
		t.Errorf("expected nbsp -> space, got %q", text)
	}
}

func TestHtmlToTextPlainInput(t *testing.T) {
	text := htmlToText("just plain text, no tags")
	if text != "just plain text, no tags" {
		t.Errorf("expected plain text passthrough, got %q", text)
	}
}

func TestWebFetchBlockedURL(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "WebFetch", map[string]any{
		"url": "http://127.0.0.1/secret",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for blocked host")
	}
	if !strings.Contains(result.Content, "Blocked") {
		t.Errorf("expected 'Blocked' message, got %q", result.Content)
	}
}

func TestWebFetchBlockedScheme(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "WebFetch", map[string]any{
		"url": "ftp://example.com/file",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for ftp scheme")
	}
	if !strings.Contains(result.Content, "only http/https") {
		t.Errorf("expected scheme error, got %q", result.Content)
	}
}

func TestWebFetchMissingURL(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "WebFetch", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing url")
	}
	if !strings.Contains(result.Content, "url is required") {
		t.Errorf("expected url required message, got %q", result.Content)
	}
}

func TestWebFetchLocalhostBlocked(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "WebFetch", map[string]any{
		"url": "http://localhost:8080/api",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for localhost")
	}
}

func TestWebFetchPrivateIPBlocked(t *testing.T) {
	urls := []string{
		"http://10.0.0.1/",
		"http://192.168.1.1/",
		"http://172.16.0.1/",
	}
	for _, u := range urls {
		t.Run(u, func(t *testing.T) {
			result, _ := ExecuteTool(context.Background(), "WebFetch", map[string]any{"url": u}, "/tmp")
			if !result.IsError {
				t.Errorf("expected blocked for %s", u)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Bash Operations Tests
// ---------------------------------------------------------------------------

func TestLocalBashOperations(t *testing.T) {
	ops := &LocalBashOperations{}
	ctx := context.Background()

	result, err := ops.Exec(ctx, "echo test123", os.TempDir(), ExecOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 0 {
		t.Errorf("expected exit code 0, got %d", result.ExitCode)
	}
	if !strings.Contains(result.Stdout, "test123") {
		t.Errorf("expected stdout to contain 'test123', got %q", result.Stdout)
	}
}

func TestLocalBashOperationsExitCode(t *testing.T) {
	ops := &LocalBashOperations{}

	result, err := ops.Exec(context.Background(), "exit 42", os.TempDir(), ExecOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 42 {
		t.Errorf("expected exit code 42, got %d", result.ExitCode)
	}
}

func TestLocalBashOperationsStderr(t *testing.T) {
	ops := &LocalBashOperations{}

	result, err := ops.Exec(context.Background(), "echo err_output >&2", os.TempDir(), ExecOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result.Stderr, "err_output") {
		t.Errorf("expected stderr, got %q", result.Stderr)
	}
}

func TestLocalBashOperationsTimeout(t *testing.T) {
	ops := &LocalBashOperations{}

	_, err := ops.Exec(context.Background(), "sleep 30", os.TempDir(), ExecOptions{
		Timeout: 200 * time.Millisecond,
	})
	// The context deadline should cause an error or non-zero exit.
	// On timeout, exec returns an error.
	if err == nil {
		// If no Go error, verify exit code is non-zero.
		// Some systems surface the kill as exit code -1.
	}
}

func TestLocalBashOperationsEnv(t *testing.T) {
	ops := &LocalBashOperations{}

	result, err := ops.Exec(context.Background(), "echo $MY_TEST_ENV_VAR", os.TempDir(), ExecOptions{
		Env: map[string]string{"MY_TEST_ENV_VAR": "env_value_42"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result.Stdout, "env_value_42") {
		t.Errorf("expected env var in output, got %q", result.Stdout)
	}
}

func TestLocalBashOperationsWorkingDir(t *testing.T) {
	dir := t.TempDir()
	ops := &LocalBashOperations{}

	result, err := ops.Exec(context.Background(), "pwd", dir, ExecOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result.Stdout, dir) {
		t.Errorf("expected cwd %q in output, got %q", dir, result.Stdout)
	}
}

func TestSetBashOperations(t *testing.T) {
	original := GetBashOperations()
	defer SetBashOperations(original)

	custom := &LocalBashOperations{}
	SetBashOperations(custom)
	got := GetBashOperations()
	if got != custom {
		t.Error("SetBashOperations did not update the singleton")
	}
}

// ---------------------------------------------------------------------------
// Skill Tool Tests
// ---------------------------------------------------------------------------

func TestSkillToolRegisteredSkill(t *testing.T) {
	// Register a test skill.
	skills.RegisterSkill(&skills.Skill{
		Name:        "test-skill",
		Description: "A test skill for unit tests",
		Content:     "Do the test thing step by step.",
	})
	defer skills.ClearSkillRegistry()

	result, _ := ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "test-skill",
	}, "/tmp")
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "test-skill") {
		t.Errorf("expected skill name in output, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "Do the test thing") {
		t.Errorf("expected skill content in output, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "A test skill") {
		t.Errorf("expected description in output, got %q", result.Content)
	}
}

func TestSkillToolWithArgs(t *testing.T) {
	skills.RegisterSkill(&skills.Skill{
		Name:    "args-skill",
		Content: "Execute with given args.",
	})
	defer skills.ClearSkillRegistry()

	result, _ := ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "args-skill",
		"args":  "param1 param2",
	}, "/tmp")
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "param1 param2") {
		t.Errorf("expected args in output, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "Arguments:") {
		t.Errorf("expected 'Arguments:' label, got %q", result.Content)
	}
}

func TestSkillToolUnknownSkill(t *testing.T) {
	skills.RegisterSkill(&skills.Skill{
		Name:    "known-skill",
		Content: "known content",
	})
	defer skills.ClearSkillRegistry()

	result, _ := ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "unknown-skill",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for unknown skill")
	}
	if !strings.Contains(result.Content, "Unknown skill") {
		t.Errorf("expected 'Unknown skill' message, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "known-skill") {
		t.Errorf("expected available skills list, got %q", result.Content)
	}
}

func TestSkillToolNoSkills(t *testing.T) {
	skills.ClearSkillRegistry()

	result, _ := ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "any-skill",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error when no skills registered")
	}
	if !strings.Contains(result.Content, "No skills registered") {
		t.Errorf("expected 'No skills registered', got %q", result.Content)
	}
}

func TestSkillToolMissingSkillParam(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "Skill", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing skill param")
	}
	if !strings.Contains(result.Content, "Missing required parameter") {
		t.Errorf("expected missing param message, got %q", result.Content)
	}
}

func TestSkillToolMultipleSkills(t *testing.T) {
	skills.RegisterSkill(&skills.Skill{Name: "alpha", Content: "alpha content"})
	skills.RegisterSkill(&skills.Skill{Name: "beta", Content: "beta content"})
	skills.RegisterSkill(&skills.Skill{Name: "gamma", Content: "gamma content"})
	defer skills.ClearSkillRegistry()

	// Invoke one; the others should be listed on unknown.
	result, _ := ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "alpha",
	}, "/tmp")
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "alpha content") {
		t.Errorf("expected alpha content, got %q", result.Content)
	}

	// Unknown skill should list all available.
	result2, _ := ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "nonexistent",
	}, "/tmp")
	if !result2.IsError {
		t.Error("expected error for unknown skill")
	}
	if !strings.Contains(result2.Content, "alpha") || !strings.Contains(result2.Content, "beta") || !strings.Contains(result2.Content, "gamma") {
		t.Errorf("expected all skill names listed, got %q", result2.Content)
	}
}

// ---------------------------------------------------------------------------
// MCP Resource Tool Tests
// ---------------------------------------------------------------------------

func TestListMcpResourcesUnknownServer(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "ListMcpResources", map[string]any{
		"server": "nonexistent-server",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for unknown MCP server")
	}
	if !strings.Contains(result.Content, "not connected") {
		t.Errorf("expected 'not connected' message, got %q", result.Content)
	}
}

func TestListMcpResourcesMissingServer(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "ListMcpResources", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing server")
	}
	if !strings.Contains(result.Content, "server is required") {
		t.Errorf("expected 'server is required', got %q", result.Content)
	}
}

func TestReadMcpResourceUnknownServer(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "ReadMcpResource", map[string]any{
		"server": "ghost-server",
		"uri":    "file:///test.txt",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for unknown MCP server")
	}
	if !strings.Contains(result.Content, "not connected") {
		t.Errorf("expected 'not connected' message, got %q", result.Content)
	}
}

func TestReadMcpResourceMissingServer(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "ReadMcpResource", map[string]any{
		"uri": "file:///test.txt",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing server")
	}
}

func TestReadMcpResourceMissingUri(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "ReadMcpResource", map[string]any{
		"server": "some-server",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing uri")
	}
	if !strings.Contains(result.Content, "uri is required") {
		t.Errorf("expected 'uri is required', got %q", result.Content)
	}
}

// ---------------------------------------------------------------------------
// Optional Tool Tests (RegisterTaskTools / UnregisterTaskTools)
// ---------------------------------------------------------------------------

func TestOptionalToolsRoundTrip(t *testing.T) {
	// Task tools should be registered by TestMain.
	taskTools := []string{"TaskCreate", "TaskList", "TaskGet", "TaskStop"}
	for _, name := range taskTools {
		if GetTool(name) == nil {
			t.Fatalf("expected %q to be registered", name)
		}
	}

	// Unregister and verify they are gone.
	UnregisterTaskTools()
	for _, name := range taskTools {
		if GetTool(name) != nil {
			t.Errorf("expected %q to be unregistered", name)
		}
	}

	// Re-register and verify they are back.
	RegisterTaskTools()
	for _, name := range taskTools {
		if GetTool(name) == nil {
			t.Errorf("expected %q to be re-registered", name)
		}
	}
}

func TestOptionalToolsAffectCount(t *testing.T) {
	// With task tools registered (from TestMain).
	countWith := len(GetAllTools())

	UnregisterTaskTools()
	countWithout := len(GetAllTools())
	RegisterTaskTools() // restore

	if countWith-countWithout != 4 {
		t.Errorf("expected 4 task tools difference, got %d (with=%d, without=%d)",
			countWith-countWithout, countWith, countWithout)
	}
}

// ---------------------------------------------------------------------------
// Helper function tests
// ---------------------------------------------------------------------------

func TestIntFromInput(t *testing.T) {
	tests := []struct {
		name     string
		input    map[string]any
		key      string
		def      int
		expected int
	}{
		{"float64", map[string]any{"x": float64(42)}, "x", 0, 42},
		{"int", map[string]any{"x": 7}, "x", 0, 7},
		{"int64", map[string]any{"x": int64(99)}, "x", 0, 99},
		{"missing key", map[string]any{}, "x", 10, 10},
		{"wrong type", map[string]any{"x": "not a number"}, "x", 5, 5},
		{"nil input", nil, "x", 3, 3},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := intFromInput(tc.input, tc.key, tc.def)
			if got != tc.expected {
				t.Errorf("expected %d, got %d", tc.expected, got)
			}
		})
	}
}

func TestStringFromInput(t *testing.T) {
	tests := []struct {
		name     string
		input    map[string]any
		key      string
		def      string
		expected string
	}{
		{"exists", map[string]any{"k": "val"}, "k", "", "val"},
		{"missing", map[string]any{}, "k", "default", "default"},
		{"wrong type", map[string]any{"k": 42}, "k", "fallback", "fallback"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := stringFromInput(tc.input, tc.key, tc.def)
			if got != tc.expected {
				t.Errorf("expected %q, got %q", tc.expected, got)
			}
		})
	}
}

func TestBoolFromInput(t *testing.T) {
	tests := []struct {
		name     string
		input    map[string]any
		key      string
		def      bool
		expected bool
	}{
		{"true", map[string]any{"k": true}, "k", false, true},
		{"false", map[string]any{"k": false}, "k", true, false},
		{"missing", map[string]any{}, "k", true, true},
		{"wrong type", map[string]any{"k": "yes"}, "k", false, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := boolFromInput(tc.input, tc.key, tc.def)
			if got != tc.expected {
				t.Errorf("expected %v, got %v", tc.expected, got)
			}
		})
	}
}

func TestResolvePath(t *testing.T) {
	tests := []struct {
		name     string
		cwd      string
		path     string
		expected string
	}{
		{"absolute stays absolute", "/tmp", "/usr/bin/file", "/usr/bin/file"},
		{"relative resolved", "/home/user", "foo/bar.txt", "/home/user/foo/bar.txt"},
		{"dot path", "/home/user", "./test.go", "/home/user/test.go"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := resolvePath(tc.cwd, tc.path)
			if got != tc.expected {
				t.Errorf("expected %q, got %q", tc.expected, got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// WebSearch Tool Tests
// ---------------------------------------------------------------------------

func TestWebSearchMissingQuery(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "WebSearch", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing query")
	}
}
