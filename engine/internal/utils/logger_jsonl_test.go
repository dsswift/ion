package utils

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// resetLoggerForTest forces the logger to re-initialize on the next write and
// points it at the given directory. It must run before any log call in a test.
// Guarded by logMu via the exported setters it wraps.
func resetLoggerForTest(t *testing.T, dir string) {
	t.Helper()
	logMu.Lock()
	if logFile != nil {
		_ = logFile.Close()
	}
	logFile = nil
	logger = nil
	bytesWritten = 0
	logDir = ""
	outputMode = "file"
	disableRotation = false
	maxLogFiles = 3
	logMu.Unlock()

	SetLevel(LevelDebug)
	ConfigureLogging(&types.LoggingConfig{LogDir: dir, OutputMode: "file"})

	t.Cleanup(func() {
		logMu.Lock()
		if logFile != nil {
			_ = logFile.Close()
		}
		logFile = nil
		logger = nil
		bytesWritten = 0
		logDir = ""
		outputMode = "file"
		maxLogFiles = 3
		logMu.Unlock()
		SetLevel(LevelInfo)
	})
}

// readLastLine parses the last JSON object written to engine.jsonl in dir.
func readLastLine(t *testing.T, dir string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "engine.jsonl"))
	if err != nil {
		t.Fatalf("read engine.jsonl: %v", err)
	}
	lines := splitNonEmptyLines(string(data))
	if len(lines) == 0 {
		t.Fatalf("engine.jsonl is empty")
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &obj); err != nil {
		t.Fatalf("last line is not valid JSON: %v\nline: %s", err, lines[len(lines)-1])
	}
	return obj
}

func splitNonEmptyLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			if i > start {
				out = append(out, s[start:i])
			}
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

func TestLogLineIsValidJSONL(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	Info("test-tag", "hello world")

	obj := readLastLine(t, dir)

	if got := obj["component"]; got != "engine" {
		t.Errorf("component = %v, want engine", got)
	}
	if got := obj["level"]; got != "INFO" {
		t.Errorf("level = %v, want INFO", got)
	}
	if got := obj["tag"]; got != "test-tag" {
		t.Errorf("tag = %v, want test-tag", got)
	}
	if got := obj["msg"]; got != "hello world" {
		t.Errorf("msg = %v, want hello world", got)
	}

	// fields must be present and be an object ({} when empty).
	fields, ok := obj["fields"].(map[string]any)
	if !ok {
		t.Fatalf("fields missing or not an object: %v", obj["fields"])
	}
	if len(fields) != 0 {
		t.Errorf("fields = %v, want empty object", fields)
	}

	// ts must be present, parse as RFC3339Nano, and carry a full date
	// (guarding against the old time-only [15:04:05] bug).
	tsRaw, ok := obj["ts"].(string)
	if !ok || tsRaw == "" {
		t.Fatalf("ts missing or not a string: %v", obj["ts"])
	}
	parsed, err := time.Parse(time.RFC3339Nano, tsRaw)
	if err != nil {
		t.Fatalf("ts %q does not parse as RFC3339Nano: %v", tsRaw, err)
	}
	if parsed.Year() < 2000 {
		t.Errorf("ts %q has no real date component (year %d)", tsRaw, parsed.Year())
	}
	if parsed.Location() != time.UTC {
		t.Errorf("ts %q is not UTC", tsRaw)
	}
}

func TestLogLevelsMapToSchemaNames(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	cases := []struct {
		fn   func(tag, msg string)
		want string
	}{
		{Debug, "DEBUG"},
		{Info, "INFO"},
		{Warn, "WARN"},
		{Error, "ERROR"},
	}
	for _, c := range cases {
		c.fn("lvl", "msg-"+c.want)
		obj := readLastLine(t, dir)
		if got := obj["level"]; got != c.want {
			t.Errorf("level = %v, want %v", got, c.want)
		}
	}
}

func TestRotateGenerationsRename(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	// Force a tiny cap and a 2-generation limit so we can drive all three
	// rotation events cheaply within the test.
	logMu.Lock()
	maxLogSize = 200
	maxLogFiles = 2
	logMu.Unlock()
	t.Cleanup(func() {
		logMu.Lock()
		maxLogSize = 20 * 1024 * 1024
		maxLogFiles = 3
		logMu.Unlock()
	})

	line := "rotation test line to grow the file past the cap"

	// ── First rotation ──────────────────────────────────────────────────────
	// Write until engine.jsonl exceeds 200 bytes.
	for i := 0; i < 20; i++ {
		Info("rot", line)
	}

	// engine.jsonl.1 must exist; live file must be small (reset after rotate).
	if _, err := os.Stat(filepath.Join(dir, "engine.jsonl.1")); err != nil {
		t.Errorf("engine.jsonl.1 missing after first rotation: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, "engine.jsonl"))
	if err != nil {
		t.Fatalf("engine.jsonl missing after first rotation: %v", err)
	}
	if info.Size() > 200+1024 {
		t.Errorf("live file size %d after first rotation exceeds expected bound", info.Size())
	}

	// ── Second rotation ─────────────────────────────────────────────────────
	// Write again until cap is hit a second time.
	for i := 0; i < 20; i++ {
		Info("rot", line)
	}

	// engine.jsonl.2 must now exist (former .1 shifted to .2).
	if _, err := os.Stat(filepath.Join(dir, "engine.jsonl.2")); err != nil {
		t.Errorf("engine.jsonl.2 missing after second rotation: %v", err)
	}

	// ── Third rotation with maxLogFiles=2 ───────────────────────────────────
	// The third rotation should prune: .2 is removed, .1→.2, live→.1.
	// engine.jsonl.3 must never appear.
	for i := 0; i < 20; i++ {
		Info("rot", line)
	}

	if _, err := os.Stat(filepath.Join(dir, "engine.jsonl.3")); err == nil {
		t.Errorf("engine.jsonl.3 should not exist with maxLogFiles=2 (pruned)")
	}
	if _, err := os.Stat(filepath.Join(dir, "engine.jsonl.2")); err != nil {
		t.Errorf("engine.jsonl.2 missing after third rotation: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "engine.jsonl.1")); err != nil {
		t.Errorf("engine.jsonl.1 missing after third rotation: %v", err)
	}

	// Artifacts that must never appear under rename-rotate.
	for _, name := range []string{"engine.jsonl.old", "engine.log.old"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			t.Errorf("unexpected rotation artifact present: %s", name)
		}
	}
}

// TestInitLoggerDiscardsUnderTestByDefault verifies the test-mode isolation
// guard: when no LogDir is configured (logDir=="") and the test binary is
// running under `go test`, initLogger must discard all output rather than
// opening the operator's live ~/.ion/engine.jsonl. The guard fires whenever
// testing.Testing() is true and logDir resolves to "" or ~/.ion.
func TestInitLoggerDiscardsUnderTestByDefault(t *testing.T) {
	// Save and restore all logger globals so this test is fully isolated.
	logMu.Lock()
	savedLogFile := logFile
	savedLogger := logger
	savedOutputMode := outputMode
	savedLogDir := logDir
	savedBytesWritten := bytesWritten

	// Force the default (unconfigured) state -- no dir, no file, no logger.
	logFile = nil
	logger = nil
	outputMode = "file"
	logDir = ""
	bytesWritten = 0
	logMu.Unlock()

	t.Cleanup(func() {
		logMu.Lock()
		if logFile != nil {
			_ = logFile.Close()
		}
		logFile = savedLogFile
		logger = savedLogger
		outputMode = savedOutputMode
		logDir = savedLogDir
		bytesWritten = savedBytesWritten
		logMu.Unlock()
	})

	// Emit a log line. Under the isolation guard this must trigger
	// initLogger's discard branch, not open ~/.ion/engine.jsonl.
	Error("Test", "should be discarded")

	// The discard branch must have installed a non-nil logger (so subsequent
	// calls don't try to re-open a file) but must NOT have opened a file.
	logMu.Lock()
	gotLogger := logger
	gotFile := logFile
	logMu.Unlock()

	if gotLogger == nil {
		t.Fatal("expected discard logger to be non-nil after first log call")
	}
	if gotFile != nil {
		t.Errorf("expected logFile to remain nil in discard branch, got %v", gotFile)
	}
}
