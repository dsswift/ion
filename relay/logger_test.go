package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"
)

// buildTestLogger creates a slog.Logger that writes to buf using the full relay
// handler chain (relayHandler + levelGatedHandler) with the given minimum level.
func buildTestLogger(buf *bytes.Buffer, minLevel slog.Level) *slog.Logger {
	opts := &slog.HandlerOptions{
		Level:       slogLevelTrace,
		ReplaceAttr: relayReplaceAttr,
	}
	base := slog.NewJSONHandler(buf, opts)
	h := &levelGatedHandler{
		inner: &relayHandler{base: base},
		min:   minLevel,
	}
	return slog.New(h)
}

// parseLastLine parses the last non-empty JSONL line from buf.
func parseLastLine(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	data := buf.Bytes()
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(lines[i]), &obj); err != nil {
			t.Fatalf("last line is not valid JSON: %v\nline: %s", err, lines[i])
		}
		return obj
	}
	t.Fatal("buffer contains no non-empty lines")
	return nil
}

// TestRelayNestedFields asserts that non-reserved attrs end up under "fields"
// and reserved attrs remain at the top level.
func TestRelayNestedFields(t *testing.T) {
	var buf bytes.Buffer
	log := buildTestLogger(&buf, slog.LevelInfo)

	log.Info("test message",
		"tag", "relay.test",
		"component", "relay",
		"channel_id", "ch-abc",
		"custom_key", "custom_value",
		"another", 42,
	)

	obj := parseLastLine(t, &buf)

	// Reserved keys must be at the top level.
	if obj["component"] != "relay" {
		t.Errorf("component = %v, want relay", obj["component"])
	}
	if obj["tag"] != "relay.test" {
		t.Errorf("tag = %v, want relay.test", obj["tag"])
	}
	if obj["channel_id"] != "ch-abc" {
		t.Errorf("channel_id = %v, want ch-abc", obj["channel_id"])
	}

	// Non-reserved keys must be nested under "fields".
	fields, ok := obj["fields"].(map[string]any)
	if !ok {
		t.Fatalf("fields missing or not an object: %v", obj["fields"])
	}
	if fields["custom_key"] != "custom_value" {
		t.Errorf("fields.custom_key = %v, want custom_value", fields["custom_key"])
	}
	if fields["channel_id"] != nil {
		t.Errorf("channel_id should not appear in fields (it is reserved), got %v", fields["channel_id"])
	}
}

// TestRelayFieldsAlwaysPresent verifies that "fields" is always emitted
// as {} even when no non-reserved attrs are supplied.
func TestRelayFieldsAlwaysPresent(t *testing.T) {
	var buf bytes.Buffer
	log := buildTestLogger(&buf, slog.LevelInfo)

	log.Info("no extra attrs", "component", "relay")

	obj := parseLastLine(t, &buf)
	fields, ok := obj["fields"]
	if !ok {
		t.Fatal("fields key missing entirely")
	}
	m, ok := fields.(map[string]any)
	if !ok {
		t.Fatalf("fields is not an object: %T %v", fields, fields)
	}
	if len(m) != 0 {
		t.Errorf("expected empty fields, got %v", m)
	}
}

// TestRelayComponentIsRelay confirms the logger stamps component=relay.
func TestRelayComponentIsRelay(t *testing.T) {
	var buf bytes.Buffer
	log := buildTestLogger(&buf, slog.LevelInfo).With("component", "relay")
	log.Info("hello")

	obj := parseLastLine(t, &buf)
	if obj["component"] != "relay" {
		t.Errorf("component = %v, want relay", obj["component"])
	}
}

// TestRelayTsIsRFC3339Nano verifies the ts key is a valid RFC3339Nano UTC timestamp.
func TestRelayTsIsRFC3339Nano(t *testing.T) {
	var buf bytes.Buffer
	log := buildTestLogger(&buf, slog.LevelInfo)
	log.Info("ts check")

	obj := parseLastLine(t, &buf)
	ts, ok := obj["ts"].(string)
	if !ok || ts == "" {
		t.Fatalf("ts missing or not a string: %v", obj["ts"])
	}
	parsed, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		t.Fatalf("ts %q does not parse as RFC3339Nano: %v", ts, err)
	}
	if parsed.Year() < 2000 {
		t.Errorf("ts %q has no real date component (year %d)", ts, parsed.Year())
	}
	if parsed.Location() != time.UTC {
		t.Errorf("ts %q is not UTC", ts)
	}
}

// TestRelayLevelSerializesUppercase confirms that INFO, WARN, ERROR are emitted
// as uppercase strings, matching the canonical Ion log schema.
func TestRelayLevelSerializesUppercase(t *testing.T) {
	cases := []struct {
		fn   func(log *slog.Logger)
		want string
	}{
		{func(l *slog.Logger) { l.Info("m") }, "INFO"},
		{func(l *slog.Logger) { l.Warn("m") }, "WARN"},
		{func(l *slog.Logger) { l.Error("m") }, "ERROR"},
	}
	for _, c := range cases {
		var buf bytes.Buffer
		log := buildTestLogger(&buf, slogLevelTrace)
		c.fn(log)
		obj := parseLastLine(t, &buf)
		if got := obj["level"]; got != c.want {
			t.Errorf("level = %v, want %v", got, c.want)
		}
	}
}

// TestRelayTraceSerializesUppercase verifies the custom TRACE slog level is
// serialised as the string "TRACE" and not "DEBUG-4" or similar.
func TestRelayTraceSerializesUppercase(t *testing.T) {
	var buf bytes.Buffer
	log := buildTestLogger(&buf, slogLevelTrace)

	// Log at the custom TRACE level.
	log.Log(context.Background(), slogLevelTrace, "trace msg")

	obj := parseLastLine(t, &buf)
	if got := obj["level"]; got != "TRACE" {
		t.Errorf("level = %v, want TRACE", got)
	}
}

// TestRelayTRACEOrderingAndSuppression verifies ordering semantics:
// INFO min-level must suppress TRACE, and RELAY_LOG_LEVEL=trace must emit it.
func TestRelayTRACEOrderingAndSuppression(t *testing.T) {
	// slogLevelTrace must be < slog.LevelDebug.
	if slogLevelTrace >= slog.LevelDebug {
		t.Errorf("slogLevelTrace (%d) must be < slog.LevelDebug (%d)", slogLevelTrace, slog.LevelDebug)
	}

	// With INFO min-level, TRACE must be suppressed.
	t.Run("INFO suppresses TRACE", func(t *testing.T) {
		var buf bytes.Buffer
		log := buildTestLogger(&buf, slog.LevelInfo)
		log.Log(context.Background(), slogLevelTrace, "should be suppressed")
		if buf.Len() > 0 {
			t.Errorf("expected no output at INFO min-level, got: %s", buf.String())
		}
	})

	// Simulate RELAY_LOG_LEVEL=trace: TRACE must be emitted.
	t.Run("RELAY_LOG_LEVEL=trace emits TRACE", func(t *testing.T) {
		t.Setenv("RELAY_LOG_LEVEL", "trace")
		var buf bytes.Buffer
		log := buildTestLogger(&buf, slogLevelTrace) // buildTestLogger already uses slogLevelTrace floor
		log.Log(context.Background(), slogLevelTrace, "trace output")
		if buf.Len() == 0 {
			t.Fatal("expected TRACE output when min=slogLevelTrace, got none")
		}
		obj := parseLastLine(t, &buf)
		if obj["level"] != "TRACE" {
			t.Errorf("level = %v, want TRACE", obj["level"])
		}
	})
}

// TestRelayFileTargetWritesCanonicalJSONL verifies that when RELAY_LOG_OUTPUT=file
// and RELAY_LOG_FILE is set, initLogger writes valid canonical JSONL to the file.
func TestRelayFileTargetWritesCanonicalJSONL(t *testing.T) {
	dir := t.TempDir()
	logPath := dir + "/relay-test.jsonl"

	t.Setenv("RELAY_LOG_OUTPUT", "file")
	t.Setenv("RELAY_LOG_FILE", logPath)
	t.Setenv("RELAY_LOG_LEVEL", "info")

	// Reset package-level state.
	logMu.Lock()
	if relayLogFile != nil {
		_ = relayLogFile.Close()
		relayLogFile = nil
	}
	relayLogPath = ""
	relayBytesWritten = 0
	logMu.Unlock()

	log := initLogger()
	log.Info("file target test", "tag", "relay.test", "foo", "bar")

	// Close the file handle so we can read it.
	logMu.Lock()
	if relayLogFile != nil {
		_ = relayLogFile.Close()
		relayLogFile = nil
	}
	relayLogPath = ""
	logMu.Unlock()

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("failed to read log file: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("log file is empty")
	}

	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	var last map[string]any
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		if err := json.Unmarshal([]byte(lines[i]), &last); err != nil {
			t.Fatalf("line is not valid JSON: %v\nline: %s", err, lines[i])
		}
		break
	}
	if last == nil {
		t.Fatal("no valid JSON lines found in file")
	}

	// Must conform to the canonical schema.
	if last["component"] != "relay" {
		t.Errorf("component = %v, want relay", last["component"])
	}
	if last["level"] != "INFO" {
		t.Errorf("level = %v, want INFO", last["level"])
	}
	if last["msg"] != "file target test" {
		t.Errorf("msg = %v, want 'file target test'", last["msg"])
	}
	if _, ok := last["ts"].(string); !ok {
		t.Errorf("ts missing or not a string: %v", last["ts"])
	}
	// fields must be present and contain the non-reserved "foo" key.
	fields, ok := last["fields"].(map[string]any)
	if !ok {
		t.Fatalf("fields missing or not an object: %v", last["fields"])
	}
	if fields["foo"] != "bar" {
		t.Errorf("fields.foo = %v, want bar", fields["foo"])
	}
}

// TestRelayRotateGenerationsRename verifies that rename-rotate creates
// generation files (.1, .2) and prunes beyond maxRelayLogFiles.
func TestRelayRotateGenerationsRename(t *testing.T) {
	dir := t.TempDir()
	logPath := dir + "/relay.jsonl"

	t.Setenv("RELAY_LOG_OUTPUT", "file")
	t.Setenv("RELAY_LOG_FILE", logPath)
	t.Setenv("RELAY_LOG_LEVEL", "info")
	t.Setenv("RELAY_LOG_MAX_FILES", "2")

	// Reset package-level state.
	logMu.Lock()
	if relayLogFile != nil {
		_ = relayLogFile.Close()
		relayLogFile = nil
	}
	relayLogPath = ""
	relayBytesWritten = 0
	maxRelayLogFiles = 3 // will be overridden by RELAY_LOG_MAX_FILES above
	logMu.Unlock()

	log := initLogger()

	// Set a tiny cap so a handful of lines trigger rotation.
	logMu.Lock()
	maxRelayLogBytes = 200
	logMu.Unlock()
	t.Cleanup(func() {
		logMu.Lock()
		maxRelayLogBytes = 20 * 1024 * 1024
		maxRelayLogFiles = 3
		logMu.Unlock()
	})

	line := "rotation test line — long enough to grow the file past 200 bytes quickly"

	// ── First rotation ──────────────────────────────────────────────────────
	for i := 0; i < 10; i++ {
		log.Info(line)
	}
	if _, err := os.Stat(logPath + ".1"); err != nil {
		t.Errorf("relay.jsonl.1 missing after first rotation: %v", err)
	}

	// ── Second rotation ─────────────────────────────────────────────────────
	for i := 0; i < 10; i++ {
		log.Info(line)
	}
	if _, err := os.Stat(logPath + ".2"); err != nil {
		t.Errorf("relay.jsonl.2 missing after second rotation: %v", err)
	}

	// ── Third rotation with maxRelayLogFiles=2 ───────────────────────────────
	// .2 must be pruned; .3 must never appear.
	for i := 0; i < 10; i++ {
		log.Info(line)
	}
	if _, err := os.Stat(logPath + ".3"); err == nil {
		t.Errorf("relay.jsonl.3 should not exist with maxRelayLogFiles=2")
	}
	if _, err := os.Stat(logPath + ".2"); err != nil {
		t.Errorf("relay.jsonl.2 missing after third rotation: %v", err)
	}
	if _, err := os.Stat(logPath + ".1"); err != nil {
		t.Errorf("relay.jsonl.1 missing after third rotation: %v", err)
	}

	// Clean up file handles.
	logMu.Lock()
	if relayLogFile != nil {
		_ = relayLogFile.Close()
		relayLogFile = nil
	}
	relayLogPath = ""
	logMu.Unlock()
}

// TestRelayErrKeyNormalisedToError confirms that an "err" attribute at the
// call site is emitted as "error" in the JSON output.
func TestRelayErrKeyNormalisedToError(t *testing.T) {
	var buf bytes.Buffer
	log := buildTestLogger(&buf, slog.LevelInfo)
	log.Info("err key test", "tag", "relay.test", "err", "something went wrong")

	obj := parseLastLine(t, &buf)
	fields, ok := obj["fields"].(map[string]any)
	if !ok {
		t.Fatalf("fields not an object: %v", obj["fields"])
	}
	if fields["error"] != "something went wrong" {
		t.Errorf("fields.error = %v, want 'something went wrong'", fields["error"])
	}
	if _, present := fields["err"]; present {
		t.Errorf("fields.err should not be present (normalised to error), got %v", fields["err"])
	}
}
