package telemetry

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// TestFlushToFile_ExpandsTilde is the BUG-1 regression pin: a telemetry
// filePath of "~/..." must resolve to os.UserHomeDir()+"/..." and the flush
// must actually write the file there. Without the tilde expansion in
// flushToFile, os.OpenFile receives the literal "~/" and creates (or fails to
// create) a directory named "~", so this test goes RED: the file never appears
// under the resolved home directory.
func TestFlushToFile_ExpandsTilde(t *testing.T) {
	// Redirect the home directory to a temp dir so "~/..." resolves somewhere
	// isolated and asserting against os.UserHomeDir() is deterministic.
	home := t.TempDir()
	t.Setenv("HOME", home)

	// Sanity: confirm the override took effect before relying on it.
	resolvedHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	if resolvedHome != home {
		t.Skipf("HOME override not honored on this platform (got %q, want %q)", resolvedHome, home)
	}

	c := NewCollector(types.TelemetryConfig{
		Enabled:  true,
		Targets:  []string{"file"},
		FilePath: "~/telemetry.jsonl",
	})

	c.Event(SessionStart, map[string]any{"sessionId": "s1"}, nil)
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	// The file must exist at the EXPANDED path, not at a literal "~/..." path.
	want := filepath.Join(home, "telemetry.jsonl")
	data, err := os.ReadFile(want)
	if err != nil {
		t.Fatalf("expected telemetry written to expanded path %q, ReadFile failed: %v", want, err)
	}
	if !strings.Contains(string(data), SessionStart) {
		t.Errorf("expected %q event in %q, got: %s", SessionStart, want, string(data))
	}

	// The literal-tilde directory must NOT have been created in the CWD.
	if _, err := os.Stat("~"); err == nil {
		t.Error("a literal '~' directory was created; tilde was not expanded")
	}
}

// TestBatchFlush_FailingTargetLogsError is the BUG-2 regression pin: a flush
// failure in the Event batch path must surface an ERROR log line (previously it
// was discarded via `_ = c.Flush()`). We point the file target at an
// unwritable path and assert an ERROR record reaches the test sink. Without the
// LogFlushError call in the batch path, no ERROR line is produced and this test
// goes RED.
func TestBatchFlush_FailingTargetLogsError(t *testing.T) {
	// A path under a nonexistent root directory: os.OpenFile can neither create
	// the parent nor the file, so flushToFile returns an error on every flush.
	badPath := "/nonexistent-root/bad-path/telemetry.jsonl"

	var mu sync.Mutex
	var errLines []string
	var errFields []map[string]any
	prevLevel := utils.GetLevel()
	utils.SetLevel(utils.LevelError)
	utils.SetTestSink(func(level utils.LogLevel, tag, msg string, fields map[string]any, _, _ string) {
		if level == utils.LevelError && tag == "telemetry" {
			mu.Lock()
			errLines = append(errLines, msg)
			errFields = append(errFields, fields)
			mu.Unlock()
		}
	})
	t.Cleanup(func() {
		utils.SetTestSink(nil)
		utils.SetLevel(prevLevel)
	})

	c := NewCollector(types.TelemetryConfig{
		Enabled:   true,
		Targets:   []string{"file"},
		FilePath:  badPath,
		BatchSize: 1, // Flush on every event.
	})

	c.Event(SessionStart, map[string]any{"sessionId": "s1"}, nil)

	mu.Lock()
	got := len(errLines)
	var firstFields map[string]any
	if got > 0 {
		firstFields = errFields[0]
	}
	mu.Unlock()

	if got == 0 {
		t.Fatal("expected an ERROR log line for the failing flush target, got none")
	}
	// The log fields must name the failing target path so the operator can see
	// WHICH target broke.
	pathVal, _ := firstFields["path"].(string)
	if !strings.Contains(pathVal, badPath) {
		t.Errorf("expected ERROR fields to include target path %q in 'path' field, got fields: %v", badPath, firstFields)
	}
}

// TestLogFlushError_RateLimitedPerDistinctError pins the once-per-distinct-error
// rate limit: repeated identical failures log once, while a NEW distinct error
// logs again.
func TestLogFlushError_RateLimitedPerDistinctError(t *testing.T) {
	var mu sync.Mutex
	var count int
	prevLevel := utils.GetLevel()
	utils.SetLevel(utils.LevelError)
	utils.SetTestSink(func(level utils.LogLevel, tag, _ string, _ map[string]any, _, _ string) {
		if level == utils.LevelError && tag == "telemetry" {
			mu.Lock()
			count++
			mu.Unlock()
		}
	})
	t.Cleanup(func() {
		utils.SetTestSink(nil)
		utils.SetLevel(prevLevel)
	})

	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})

	// Same error string three times -> one log line.
	c.LogFlushError(errString("disk full"))
	c.LogFlushError(errString("disk full"))
	c.LogFlushError(errString("disk full"))
	// A distinct error string -> one more log line.
	c.LogFlushError(errString("permission denied"))

	mu.Lock()
	got := count
	mu.Unlock()
	if got != 2 {
		t.Errorf("expected 2 ERROR lines (1 per distinct error), got %d", got)
	}
}

// errString is a trivial error whose message is the string itself, used to
// drive the rate-limit dedup key deterministically.
type errString string

func (e errString) Error() string { return string(e) }
