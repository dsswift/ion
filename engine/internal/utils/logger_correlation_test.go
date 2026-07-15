package utils

import (
	"context"
	"testing"
)

func TestLogCtxPropagatesSessionID(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	ctx := context.Background()
	ctx = WithSessionID(ctx, "test-session-123")
	ctx = WithConversationID(ctx, "test-conv-456")
	ctx = WithTraceID(ctx, "4bf92f3577b34da6a3ce929d0e0e4736")

	LogCtx(ctx, LevelInfo, "test", "hello with context", map[string]any{"k": "v"})

	obj := readLastLine(t, dir)

	if got := obj["session_id"]; got != "test-session-123" {
		t.Errorf("session_id = %v, want test-session-123", got)
	}
	if got := obj["conversation_id"]; got != "test-conv-456" {
		t.Errorf("conversation_id = %v, want test-conv-456", got)
	}
	if got := obj["trace_id"]; got != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Errorf("trace_id = %v, want the 32-hex trace id", got)
	}
	if got := obj["component"]; got != "engine" {
		t.Errorf("component = %v, want engine", got)
	}
	fields, ok := obj["fields"].(map[string]any)
	if !ok {
		t.Fatalf("fields missing or not an object: %v", obj["fields"])
	}
	if got := fields["k"]; got != "v" {
		t.Errorf("fields.k = %v, want v", got)
	}
}

// TestLogCtxOmitsAbsentIDs verifies the empty-string rule: correlation IDs not
// in scope must be omitted entirely, never emitted as "".
func TestLogCtxOmitsAbsentIDs(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	ctx := WithSessionID(context.Background(), "only-session")
	LogCtx(ctx, LevelInfo, "test", "partial context", nil)

	obj := readLastLine(t, dir)

	if got := obj["session_id"]; got != "only-session" {
		t.Errorf("session_id = %v, want only-session", got)
	}
	if _, present := obj["conversation_id"]; present {
		t.Errorf("conversation_id must be omitted when not in scope, got %v", obj["conversation_id"])
	}
	if _, present := obj["trace_id"]; present {
		t.Errorf("trace_id must be omitted when not in scope, got %v", obj["trace_id"])
	}
}

func TestLogExtensionComponentAndFields(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	LogExtension(LevelDebug, "my-agent", "tool called",
		map[string]any{"tool": "Read", "duration_ms": 12},
		"sess-1", "conv-1")

	obj := readLastLine(t, dir)

	if got := obj["component"]; got != "extension" {
		t.Errorf("component = %v, want extension", got)
	}
	if got := obj["tag"]; got != "my-agent" {
		t.Errorf("tag = %v, want my-agent", got)
	}
	if got := obj["session_id"]; got != "sess-1" {
		t.Errorf("session_id = %v, want sess-1", got)
	}
	if got := obj["conversation_id"]; got != "conv-1" {
		t.Errorf("conversation_id = %v, want conv-1", got)
	}
	fields, ok := obj["fields"].(map[string]any)
	if !ok {
		t.Fatalf("fields missing or not an object: %v", obj["fields"])
	}
	if got := fields["tool"]; got != "Read" {
		t.Errorf("fields.tool = %v, want Read", got)
	}
}
