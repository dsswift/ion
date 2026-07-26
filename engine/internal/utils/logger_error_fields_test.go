package utils

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

// A bare error in a log field must reach the file as its message, not as the
// empty object encoding/json produces for a struct with no exported fields.
//
// Red before normalizeFieldValues: errors.errorString and fmt.wrapError both
// serialized as {}, so every failure branch that logged `"error": err` instead
// of `"error": utils.ErrStr(err)` wrote a line with no diagnostic content.
func TestLogFields_BareErrorSerializesAsMessage(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	LogWithFields(LevelError, "test.errfield", "operation failed", map[string]any{
		"key":   "session-1",
		"error": errors.New("disk on fire"),
	})

	rec := readLastLine(t, dir)
	fields, ok := rec["fields"].(map[string]any)
	if !ok {
		t.Fatalf("fields missing or wrong shape: %#v", rec["fields"])
	}
	if got := fields["error"]; got != "disk on fire" {
		t.Errorf("error field = %#v, want the message string", got)
	}
	// Untouched neighbours still ride through verbatim.
	if got := fields["key"]; got != "session-1" {
		t.Errorf("key field = %#v, want session-1", got)
	}
}

// A wrapped error keeps its full chain text, so the %w context is not lost.
func TestLogFields_WrappedErrorKeepsChain(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	wrapped := fmt.Errorf("loading conversation: %w", errors.New("no such file"))
	LogWithFields(LevelWarn, "test.errfield", "load failed", map[string]any{"error": wrapped})

	fields, ok := readLastLine(t, dir)["fields"].(map[string]any)
	if !ok {
		t.Fatal("fields missing")
	}
	if got := fields["error"]; got != "loading conversation: no such file" {
		t.Errorf("error field = %#v, want the full wrapped chain", got)
	}
}

// Any field key holding an error is normalized, not just the conventional
// "error" key — several call sites use "cerr", "load_error", and similar.
func TestLogFields_NormalizesEveryErrorValuedKey(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	LogWithFields(LevelInfo, "test.errfield", "multi", map[string]any{
		"cerr":       errors.New("cancelled"),
		"load_error": errors.New("bad header"),
		"count":      3,
	})

	fields, ok := readLastLine(t, dir)["fields"].(map[string]any)
	if !ok {
		t.Fatal("fields missing")
	}
	if got := fields["cerr"]; got != "cancelled" {
		t.Errorf("cerr = %#v, want cancelled", got)
	}
	if got := fields["load_error"]; got != "bad header" {
		t.Errorf("load_error = %#v, want bad header", got)
	}
	if got, want := fields["count"], float64(3); got != want {
		t.Errorf("count = %#v, want %v", got, want)
	}
}

// marshalErr opts into a specific wire shape, so normalization must leave it
// alone rather than flattening it to a string.
type marshalErr struct{}

func (marshalErr) Error() string { return "structured failure" }
func (marshalErr) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]string{"code": "E_STRUCTURED"})
}

func TestLogFields_JSONMarshalerErrorPreservedAsObject(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	LogWithFields(LevelInfo, "test.errfield", "custom", map[string]any{"error": marshalErr{}})

	fields, ok := readLastLine(t, dir)["fields"].(map[string]any)
	if !ok {
		t.Fatal("fields missing")
	}
	obj, ok := fields["error"].(map[string]any)
	if !ok {
		t.Fatalf("error field = %#v, want the marshaler's object shape", fields["error"])
	}
	if obj["code"] != "E_STRUCTURED" {
		t.Errorf("error.code = %#v, want E_STRUCTURED", obj["code"])
	}
}

// The caller's map must not be mutated: a caller may log the same map twice or
// read it afterward, and rewriting their values in place would be a side effect
// the logger has no business having.
func TestLogFields_DoesNotMutateCallerMap(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	err := errors.New("boom")
	fields := map[string]any{"error": err}
	LogWithFields(LevelInfo, "test.errfield", "no mutation", fields)

	if fields["error"] != any(err) {
		t.Errorf("caller map was mutated: error = %#v, want the original error value", fields["error"])
	}
}
