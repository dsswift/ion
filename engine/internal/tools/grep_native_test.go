package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The Windows failure this covers: neither rg nor grep is on PATH, so Grep
// returned `exec: "grep": executable file not found in %PATH%` for every call
// -- a hard failure with no degraded mode. Emptying PATH reproduces that
// machine on any platform.
func withNoSearchBinaries(t *testing.T) {
	t.Helper()
	t.Setenv("PATH", "")
}

func writeTree(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for name, body := range files {
		full := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", full, err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", full, err)
		}
	}
	return root
}

func TestGrepWithoutAnySearchBinary(t *testing.T) {
	withNoSearchBinaries(t)
	root := writeTree(t, map[string]string{
		"a.go":                 "package main\nfunc Target() {}\n",
		"b.go":                 "package main\n// nothing here\n",
		"sub/c.go":             "package sub\nfunc Target() {}\n",
		"node_modules/skip.go": "func Target() {}\n",
	})

	res, err := executeGrep(context.Background(), map[string]any{"pattern": "func Target"}, root)
	if err != nil {
		t.Fatalf("executeGrep: %v", err)
	}
	if res.IsError {
		t.Fatalf("Grep failed with no binaries on PATH: %s", res.Content)
	}
	if !strings.Contains(res.Content, "a.go") || !strings.Contains(res.Content, "c.go") {
		t.Errorf("expected both matches, got:\n%s", res.Content)
	}
	if strings.Contains(res.Content, "b.go") {
		t.Errorf("non-matching file reported:\n%s", res.Content)
	}
	// node_modules dominates a walk and never holds the answer to a source
	// search; rg gets this from .gitignore, the native path from a skip list.
	if strings.Contains(res.Content, "node_modules") {
		t.Errorf("node_modules was searched:\n%s", res.Content)
	}
}

func TestGrepNativeOutputModes(t *testing.T) {
	withNoSearchBinaries(t)
	root := writeTree(t, map[string]string{
		"one.txt": "hit\nmiss\nhit\n",
		"two.txt": "hit\n",
	})

	for _, tc := range []struct {
		mode  string
		check func(t *testing.T, out string)
	}{
		{"content", func(t *testing.T, out string) {
			// path:line:text, the same shape the ripgrep path emits.
			if !strings.Contains(out, "one.txt:1:hit") || !strings.Contains(out, "one.txt:3:hit") {
				t.Errorf("content mode lost line numbers:\n%s", out)
			}
		}},
		{"files_with_matches", func(t *testing.T, out string) {
			if strings.Contains(out, ":1:") {
				t.Errorf("files_with_matches emitted line content:\n%s", out)
			}
			if !strings.Contains(out, "one.txt") || !strings.Contains(out, "two.txt") {
				t.Errorf("missing a file:\n%s", out)
			}
		}},
		{"count", func(t *testing.T, out string) {
			if !strings.Contains(out, "one.txt:2") {
				t.Errorf("count mode wrong for a 2-match file:\n%s", out)
			}
		}},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			res, err := executeGrep(context.Background(),
				map[string]any{"pattern": "hit", "output_mode": tc.mode}, root)
			if err != nil {
				t.Fatalf("executeGrep: %v", err)
			}
			if res.IsError {
				t.Fatalf("mode %s failed: %s", tc.mode, res.Content)
			}
			tc.check(t, res.Content)
		})
	}
}

func TestGrepNativeGlobFilter(t *testing.T) {
	withNoSearchBinaries(t)
	root := writeTree(t, map[string]string{
		"keep.go":  "needle\n",
		"skip.txt": "needle\n",
	})

	res, err := executeGrep(context.Background(),
		map[string]any{"pattern": "needle", "glob": "*.go"}, root)
	if err != nil {
		t.Fatalf("executeGrep: %v", err)
	}
	if !strings.Contains(res.Content, "keep.go") {
		t.Errorf("glob excluded a file it should match:\n%s", res.Content)
	}
	if strings.Contains(res.Content, "skip.txt") {
		t.Errorf("glob did not exclude a non-matching extension:\n%s", res.Content)
	}
}

func TestGrepNativeNoMatchesWording(t *testing.T) {
	withNoSearchBinaries(t)
	root := writeTree(t, map[string]string{"a.txt": "nothing\n"})

	res, err := executeGrep(context.Background(), map[string]any{"pattern": "absent"}, root)
	if err != nil {
		t.Fatalf("executeGrep: %v", err)
	}
	if res.IsError {
		t.Fatalf("no-match should not be an error: %s", res.Content)
	}
	// Identical wording to the ripgrep path, so a caller cannot tell which
	// engine answered.
	if res.Content != "(no matches)" {
		t.Errorf("no-match wording = %q, want %q", res.Content, "(no matches)")
	}
}

func TestGrepNativeSkipsBinaryFiles(t *testing.T) {
	withNoSearchBinaries(t)
	root := t.TempDir()
	// A NUL in the first block is how rg decides a file is binary.
	if err := os.WriteFile(filepath.Join(root, "blob.bin"),
		[]byte("needle\x00\x01\x02needle"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src.txt"), []byte("needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := executeGrep(context.Background(), map[string]any{"pattern": "needle"}, root)
	if err != nil {
		t.Fatalf("executeGrep: %v", err)
	}
	if strings.Contains(res.Content, "blob.bin") {
		t.Errorf("binary file searched:\n%s", res.Content)
	}
	if !strings.Contains(res.Content, "src.txt") {
		t.Errorf("text file missed:\n%s", res.Content)
	}
}

func TestGrepNativeInvalidPattern(t *testing.T) {
	withNoSearchBinaries(t)
	root := writeTree(t, map[string]string{"a.txt": "x\n"})

	res, err := executeGrep(context.Background(), map[string]any{"pattern": "([unclosed"}, root)
	if err != nil {
		t.Fatalf("executeGrep: %v", err)
	}
	// A bad regex is the caller's mistake and must say so, not look like an
	// empty result set.
	if !res.IsError {
		t.Errorf("invalid pattern was not reported as an error: %s", res.Content)
	}
}

func TestGrepNativeSearchesASingleFile(t *testing.T) {
	withNoSearchBinaries(t)
	root := writeTree(t, map[string]string{
		"target.txt": "needle\n",
		"other.txt":  "needle\n",
	})

	res, err := executeGrep(context.Background(),
		map[string]any{"pattern": "needle", "path": "target.txt"}, root)
	if err != nil {
		t.Fatalf("executeGrep: %v", err)
	}
	if !strings.Contains(res.Content, "target.txt") {
		t.Errorf("named file not searched:\n%s", res.Content)
	}
	if strings.Contains(res.Content, "other.txt") {
		t.Errorf("a file path target leaked into a directory walk:\n%s", res.Content)
	}
}

func TestGrepNativeCancellation(t *testing.T) {
	withNoSearchBinaries(t)
	root := writeTree(t, map[string]string{"a.txt": "needle\n"})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	res, err := executeGrep(ctx, map[string]any{"pattern": "needle"}, root)
	if err != nil {
		t.Fatalf("executeGrep: %v", err)
	}
	// A cancel must surface as a tool result the model can read, not a crash.
	if !res.IsError || !strings.Contains(res.Content, "cancel") {
		t.Errorf("cancellation not surfaced: err=%v content=%q", res.IsError, res.Content)
	}
}

// A Windows profile search timed out at 60s. The walk opened every file under
// C:\Users\<name> -- measured at 29,177, of which AppData alone held 20,109 --
// and each open also pays Defender's real-time scan.
func TestGrepNativeSkipsWindowsProfileTrees(t *testing.T) {
	withNoSearchBinaries(t)
	root := writeTree(t, map[string]string{
		"code/main.go":                   "needle\n",
		"AppData/Local/cache/thing.txt":  "needle\n",
		"Application Data/legacy.txt":    "needle\n",
		"Local Settings/History/old.txt": "needle\n",
	})

	res, err := executeGrep(context.Background(), map[string]any{"pattern": "needle"}, root)
	if err != nil {
		t.Fatalf("executeGrep: %v", err)
	}
	if !strings.Contains(res.Content, "main.go") {
		t.Errorf("real source file missed:\n%s", res.Content)
	}
	// Assert on the FILE that should not have been reached, not on the
	// directory name: on Windows t.TempDir() is itself under AppData, so a
	// substring check for "AppData" matches the harness's own path and fails
	// against correct behaviour.
	for _, skipped := range []string{"thing.txt", "legacy.txt", "old.txt"} {
		if strings.Contains(res.Content, skipped) {
			t.Errorf("a file under a skipped profile tree was searched (%s):\n%s", skipped, res.Content)
		}
	}
}

// Skipping by name must never apply to the directory the caller NAMED.
// Returning "(no matches)" for `path: node_modules` would be a worse failure
// than a slow search: it is silence that looks like an answer.
func TestGrepNativeSearchesAnExplicitlyNamedSkipDir(t *testing.T) {
	withNoSearchBinaries(t)
	root := writeTree(t, map[string]string{
		"node_modules/pkg/index.js": "needle\n",
	})

	res, err := executeGrep(context.Background(),
		map[string]any{"pattern": "needle", "path": "node_modules"}, root)
	if err != nil {
		t.Fatalf("executeGrep: %v", err)
	}
	if !strings.Contains(res.Content, "index.js") {
		t.Errorf("an explicitly named skip-list directory was not searched:\n%s", res.Content)
	}
}

// A deadline must return what was found. Throwing away real matches and
// reporting only "exceeded 60s" hides that matches existed at all.
func TestGrepNativeReturnsPartialResultsOnTimeout(t *testing.T) {
	withNoSearchBinaries(t)
	files := map[string]string{}
	for i := 0; i < 300; i++ {
		files[filepath.Join("d", strings.Repeat("x", 3)+string(rune('a'+i%26))+"_"+strings.Repeat("y", i%5)+".txt")] = "needle\n"
	}
	root := writeTree(t, files)

	// Cancel while the walk is in flight.
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(2 * time.Millisecond)
		cancel()
	}()

	res, err := executeGrep(ctx, map[string]any{"pattern": "needle"}, root)
	if err != nil {
		t.Fatalf("executeGrep: %v", err)
	}
	// Either it finished before the cancel landed, or it returned partials
	// with a notice. What it must never do is report a bare error while
	// holding matches.
	if res.IsError && strings.Contains(res.Content, "needle") {
		t.Errorf("matches were found but reported as a bare error:\n%s", res.Content)
	}
	if strings.Contains(res.Content, "incomplete:") && !strings.Contains(res.Content, ".txt") {
		t.Errorf("incomplete notice with no matches attached:\n%s", res.Content)
	}
}
