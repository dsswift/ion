package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

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

// TestGlobToolHonorsCtxCancel verifies that executeGlob returns promptly when
// the caller's context is cancelled before the call. This proves the ctx
// propagation path that prevents the stuck-tab class of bug: a long-running
// glob (e.g. a wide pattern over a huge subtree) must abort on cancel rather
// than wedging the goroutine.
func TestGlobToolHonorsCtxCancel(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.go"), []byte("x"), 0o644)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled

	start := time.Now()
	result, err := ExecuteTool(ctx, "Glob", map[string]any{
		"pattern": "**/*",
		"path":    dir,
	}, dir)
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Errorf("expected IsError=true on cancelled ctx, got %q", result.Content)
	}
	if elapsed > 500*time.Millisecond {
		t.Errorf("expected fast return on cancelled ctx, took %s", elapsed)
	}
}

// TestGlobToolHonorsCtxDeadline verifies the wall-clock deadline path. With
// a 1ms deadline, even a successful walk should be cut off and surface the
// deadline as a tool-result error rather than running to completion.
func TestGlobToolHonorsCtxDeadline(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 10; i++ {
		os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%d.txt", i)), []byte("x"), 0o644)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
	defer cancel()
	// Sleep past the deadline to guarantee it has fired before the call.
	time.Sleep(5 * time.Millisecond)

	start := time.Now()
	result, _ := ExecuteTool(ctx, "Glob", map[string]any{
		"pattern": "**/*",
		"path":    dir,
	}, dir)
	elapsed := time.Since(start)

	if !result.IsError {
		t.Errorf("expected IsError=true after deadline, got %q", result.Content)
	}
	if elapsed > 500*time.Millisecond {
		t.Errorf("expected fast return after deadline, took %s", elapsed)
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
