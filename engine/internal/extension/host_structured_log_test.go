package extension

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// readStructuredLogLines reads and JSON-parses every line of engine.jsonl in dir.
func readStructuredLogLines(t *testing.T, dir string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "engine.jsonl"))
	if err != nil {
		t.Fatalf("read engine.jsonl: %v", err)
	}
	var out []map[string]any
	for _, ln := range strings.Split(string(data), "\n") {
		ln = strings.TrimSpace(ln)
		if ln == "" {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(ln), &obj); err != nil {
			t.Fatalf("log line is not valid JSON: %v\nline: %s", err, ln)
		}
		out = append(out, obj)
	}
	return out
}

// findStructuredLog returns the first parsed log object whose msg equals want.
func findStructuredLog(lines []map[string]any, want string) map[string]any {
	for _, obj := range lines {
		if m, _ := obj["msg"].(string); m == want {
			return obj
		}
	}
	return nil
}

// TestExtensionLogNotificationStructured verifies that an SDK "log" JSON-RPC
// notification lands in engine.jsonl as a structured line with
// component="extension", tag=<extension name>, the fields object preserved
// verbatim (NOT concatenated into msg), and the bound session/conversation IDs
// stamped.
func TestExtensionLogNotificationStructured(t *testing.T) {
	dir := t.TempDir()
	// Redirect engine logs to a temp file and allow DEBUG through.
	utils.SetLevel(utils.LevelDebug)
	utils.ConfigureLogging(&types.LoggingConfig{LogDir: dir, OutputMode: "file"})
	t.Cleanup(func() {
		utils.SetLevel(utils.LevelInfo)
	})

	h := NewHost()
	h.SetNameForTest("my-agent")
	h.BindSession("sess-123", "conv-456")

	raw := []byte(`{
		"params": {
			"level": "debug",
			"message": "tool called",
			"fields": {"tool": "Read", "path": "/tmp/foo.txt", "duration_ms": 12}
		}
	}`)

	h.handleExtNotification("log", raw)

	lines := readStructuredLogLines(t, dir)
	obj := findStructuredLog(lines, "tool called")
	if obj == nil {
		t.Fatalf("no log line with msg=%q found; got %d lines", "tool called", len(lines))
	}

	if got := obj["component"]; got != "extension" {
		t.Errorf("component = %v, want extension", got)
	}
	if got := obj["tag"]; got != "my-agent" {
		t.Errorf("tag = %v, want my-agent (the extension name)", got)
	}
	if got := obj["session_id"]; got != "sess-123" {
		t.Errorf("session_id = %v, want sess-123", got)
	}
	if got := obj["conversation_id"]; got != "conv-456" {
		t.Errorf("conversation_id = %v, want conv-456", got)
	}

	// The message must NOT have the fields JSON concatenated onto it (the old
	// bug). Guard by asserting msg is exactly the original and carries no "{".
	msg, _ := obj["msg"].(string)
	if msg != "tool called" {
		t.Errorf("msg = %q, want exactly %q (fields must not be concatenated)", msg, "tool called")
	}
	if strings.Contains(msg, "{") {
		t.Errorf("msg %q contains %q — fields were concatenated into the message", msg, "{")
	}

	// Fields must be preserved as a structured object.
	fields, ok := obj["fields"].(map[string]any)
	if !ok {
		t.Fatalf("fields missing or not an object: %v", obj["fields"])
	}
	if got := fields["tool"]; got != "Read" {
		t.Errorf("fields.tool = %v, want Read", got)
	}
	if got := fields["path"]; got != "/tmp/foo.txt" {
		t.Errorf("fields.path = %v, want /tmp/foo.txt", got)
	}
	// JSON numbers decode as float64.
	if got, _ := fields["duration_ms"].(float64); got != 12 {
		t.Errorf("fields.duration_ms = %v, want 12", fields["duration_ms"])
	}
}

// TestExtensionLogUnboundOmitsIDs verifies that when a host has not been bound
// to a session, the correlation IDs are omitted entirely (empty-string rule).
func TestExtensionLogUnboundOmitsIDs(t *testing.T) {
	dir := t.TempDir()
	utils.SetLevel(utils.LevelDebug)
	utils.ConfigureLogging(&types.LoggingConfig{LogDir: dir, OutputMode: "file"})
	t.Cleanup(func() {
		utils.SetLevel(utils.LevelInfo)
	})

	h := NewHost()
	h.SetNameForTest("unbound-agent")

	raw := []byte(`{"params":{"level":"info","message":"no session here"}}`)
	h.handleExtNotification("log", raw)

	lines := readStructuredLogLines(t, dir)
	obj := findStructuredLog(lines, "no session here")
	if obj == nil {
		t.Fatalf("expected log line not found")
	}
	if _, present := obj["session_id"]; present {
		t.Errorf("session_id must be omitted when unbound, got %v", obj["session_id"])
	}
	if _, present := obj["conversation_id"]; present {
		t.Errorf("conversation_id must be omitted when unbound, got %v", obj["conversation_id"])
	}
	// fields must still be present as {} even when none were sent.
	if _, ok := obj["fields"].(map[string]any); !ok {
		t.Errorf("fields missing or not an object: %v", obj["fields"])
	}
}
