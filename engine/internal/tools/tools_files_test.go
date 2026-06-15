package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

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

func TestReadToolImage_PNG(t *testing.T) {
	dir := t.TempDir()
	pngPath := filepath.Join(dir, "screenshot.png")
	// Minimal PNG header bytes
	pngData := []byte{
		0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
		0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
	}
	os.WriteFile(pngPath, pngData, 0o644)

	result, err := ExecuteTool(context.Background(), "Read", map[string]any{"file_path": pngPath}, dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error result: %s", result.Content)
	}
	// Should return image metadata in Content text
	if !strings.Contains(result.Content, "screenshot.png") {
		t.Errorf("expected filename in content, got %q", result.Content)
	}
	// Should carry base64 image data
	if len(result.Images) != 1 {
		t.Fatalf("expected 1 image, got %d", len(result.Images))
	}
	if result.Images[0].MediaType != "image/png" {
		t.Errorf("expected image/png, got %q", result.Images[0].MediaType)
	}
	if result.Images[0].Data == "" {
		t.Error("expected non-empty base64 data")
	}
}

func TestReadToolImage_JPEG(t *testing.T) {
	dir := t.TempDir()
	jpgPath := filepath.Join(dir, "photo.jpg")
	os.WriteFile(jpgPath, []byte{0xFF, 0xD8, 0xFF, 0xE0}, 0o644)

	result, _ := ExecuteTool(context.Background(), "Read", map[string]any{"file_path": jpgPath}, dir)
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if len(result.Images) != 1 {
		t.Fatalf("expected 1 image, got %d", len(result.Images))
	}
	if result.Images[0].MediaType != "image/jpeg" {
		t.Errorf("expected image/jpeg, got %q", result.Images[0].MediaType)
	}
}

func TestReadToolImage_UnsupportedFormat(t *testing.T) {
	dir := t.TempDir()
	bmpPath := filepath.Join(dir, "image.bmp")
	os.WriteFile(bmpPath, []byte("BM"), 0o644)

	result, _ := ExecuteTool(context.Background(), "Read", map[string]any{"file_path": bmpPath}, dir)
	// .bmp is not a supported image format, should fall through to text read
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if len(result.Images) != 0 {
		t.Error("expected no images for unsupported format")
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
// Per-path file lock regression tests
// ---------------------------------------------------------------------------

// TestParallelEditsSameFile issues 10 concurrent Edit calls against the same
// file, each removing a distinct line. Without the per-path lock the edits
// race and most are silently lost; with the lock all 10 land.
func TestParallelEditsSameFile(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "parallel-edit.txt")

	// Create a 20-line file: "line-00\nline-01\n…\nline-19\n"
	const totalLines = 20
	const editsToMake = 10
	var sb strings.Builder
	for i := 0; i < totalLines; i++ {
		fmt.Fprintf(&sb, "line-%02d\n", i)
	}
	if err := os.WriteFile(filePath, []byte(sb.String()), 0o644); err != nil {
		t.Fatalf("setup: write file: %v", err)
	}

	// Issue editsToMake concurrent Edit calls, each removing one distinct line.
	// We remove even-numbered lines: line-00, line-02, …, line-18.
	ctx := context.Background()
	errs := make([]error, editsToMake)
	results := make([]string, editsToMake)
	var wg sync.WaitGroup
	for i := 0; i < editsToMake; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			lineToRemove := fmt.Sprintf("line-%02d\n", i*2)
			res, err := ExecuteTool(ctx, "Edit", map[string]any{
				"file_path":  filePath,
				"old_string": lineToRemove,
				"new_string": "",
			}, dir)
			errs[i] = err
			if res != nil {
				results[i] = res.Content
			}
		}()
	}
	wg.Wait()

	// All calls should succeed without internal errors.
	for i, err := range errs {
		if err != nil {
			t.Errorf("edit %d returned error: %v", i, err)
		}
	}
	for i, r := range results {
		if !strings.Contains(r, "Successfully edited") {
			t.Errorf("edit %d did not report success: %s", i, r)
		}
	}

	// The file should have exactly totalLines - editsToMake lines remaining,
	// and all of them should be odd-numbered lines.
	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("read result file: %v", err)
	}
	remaining := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	if len(remaining) != totalLines-editsToMake {
		t.Fatalf("expected %d lines remaining, got %d:\n%s",
			totalLines-editsToMake, len(remaining), string(data))
	}
	for _, line := range remaining {
		if line == "" {
			continue
		}
		// All remaining lines should be odd-numbered (01, 03, 05, …, 19)
		var num int
		if _, err := fmt.Sscanf(line, "line-%02d", &num); err != nil {
			t.Errorf("unexpected line format: %q", line)
			continue
		}
		if num%2 == 0 {
			t.Errorf("even line %q should have been removed but is still present", line)
		}
	}
}

// TestParallelWritesSameFile issues 10 concurrent Write calls against the same
// file. With the per-path lock, each write completes atomically (no torn
// writes); the final content is one of the 10 payloads in its entirety.
func TestParallelWritesSameFile(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "parallel-write.txt")

	const numWriters = 10
	ctx := context.Background()
	payloads := make([]string, numWriters)
	for i := 0; i < numWriters; i++ {
		// Each payload is unique and non-trivial so a torn write is detectable.
		payloads[i] = fmt.Sprintf("writer-%d-content\n"+
			"this is the payload from writer %d\n"+
			"it spans multiple lines to detect torn writes\n", i, i)
	}

	var wg sync.WaitGroup
	for i := 0; i < numWriters; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = ExecuteTool(ctx, "Write", map[string]any{
				"file_path": filePath,
				"content":   payloads[i],
			}, dir)
		}()
	}
	wg.Wait()

	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("read result file: %v", err)
	}
	content := string(data)

	// The final file must be exactly one of the payloads — not a mix.
	found := false
	for i, p := range payloads {
		if content == p {
			t.Logf("final content is from writer %d", i)
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("file content does not match any payload — possible torn write:\n%s", content)
	}
}

// TestFileLockSamePathDifferentForms verifies that relative and absolute
// references to the same file share the same lock (both go through
// resolvePath which canonicalizes to an absolute path).
func TestFileLockSamePathDifferentForms(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "canonical.txt")

	// Create a file with two lines.
	if err := os.WriteFile(filePath, []byte("line-a\nline-b\n"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}

	ctx := context.Background()
	var wg sync.WaitGroup

	// One goroutine uses the absolute path, the other uses the relative name
	// (with cwd=dir). Both should serialize and both edits should land.
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = ExecuteTool(ctx, "Edit", map[string]any{
			"file_path":  filePath, // absolute
			"old_string": "line-a\n",
			"new_string": "",
		}, dir)
	}()
	go func() {
		defer wg.Done()
		_, _ = ExecuteTool(ctx, "Edit", map[string]any{
			"file_path":  "canonical.txt", // relative — resolved via cwd
			"old_string": "line-b\n",
			"new_string": "",
		}, dir)
	}()
	wg.Wait()

	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("read result: %v", err)
	}
	if string(data) != "" {
		t.Errorf("expected empty file after removing both lines, got: %q", string(data))
	}
}
