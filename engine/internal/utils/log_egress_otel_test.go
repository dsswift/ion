package utils

// log_egress_otel_test.go — tests for the LOSSLESS OTLP egress exporter (Part G).
//
// The exporter must carry the COMPLETE canonical record to every OTLP log
// record: the full serialized Ion JSONL as the body (so Alloy's ion_otlp_unwrap
// pipeline can rewrite the Loki line to a parseable JSON object); and
// component/tag and every present correlation ID + user as attributes; and
// every key in the fields map flattened to a natively-typed attribute
// (string/bool/int/double scalars; JSON-stringified nested objects/arrays).
// Nothing is dropped.
//
// The typing convention (native scalar; whole-valued floats promoted to
// intValue) is shared byte-for-byte with the desktop exporter
// (desktop/src/main/log-egress.ts). The desktop mirror test asserts the same
// canonical record produces the same attribute keys/types.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// canonicalRecord is the fixture pinned by both the engine table test here and
// the desktop parity test. It carries a mixed-scalar + nested fields map, all
// three populated top-level correlation IDs, and user. run_id lives inside
// fields (per the operational schema) and must survive as its own attribute.
func canonicalRecord() egressRecord {
	return egressRecord{
		Ts:             "2024-11-15T22:04:05.123456789Z",
		Level:          "INFO",
		Msg:            "session started",
		Component:      "engine",
		Tag:            "session",
		SessionID:      "sess-abc",
		ConversationID: "1780093348767-c1c03e998388",
		TraceID:        "4bf92f3577b34da6a3ce929d0e0e4736",
		User:           "user@example.com",
		Fields: map[string]any{
			"run_id":      "run-xyz",
			"model":       "claude-opus-4-5",
			"turn":        3,
			"cost_usd":    0.0123,
			"cache_hit":   true,
			"duration_ms": 42,
			"nested":      map[string]any{"a": 1, "b": "two"},
			"list":        []any{"x", "y", "z"},
			"whole_float": 5.0,
		},
	}
}

// decodeOtelBody captures the single OTLP export payload the exporter POSTs and
// returns the flattened attribute map + the record body for the first (only)
// log record.
func decodeOtelBody(t *testing.T, rec egressRecord) (attrs map[string]otlpLogAttrVal, body string, severityText string, severityNumber int) {
	t.Helper()

	var payload otlpLogsExportRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode otlp payload: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	cfg := &types.OtelConfig{Endpoint: srv.URL, ServiceName: "ion-engine"}
	if err := flushEgressToOtel([]egressRecord{rec}, cfg); err != nil {
		t.Fatalf("flushEgressToOtel: %v", err)
	}

	if len(payload.ResourceLogs) != 1 {
		t.Fatalf("want 1 resourceLog, got %d", len(payload.ResourceLogs))
	}
	sl := payload.ResourceLogs[0].ScopeLogs
	if len(sl) != 1 || len(sl[0].LogRecords) != 1 {
		t.Fatalf("want 1 scopeLog with 1 record, got %d scopeLogs", len(sl))
	}
	lr := sl[0].LogRecords[0]

	attrs = make(map[string]otlpLogAttrVal, len(lr.Attributes))
	for _, a := range lr.Attributes {
		if _, dup := attrs[a.Key]; dup {
			t.Errorf("duplicate attribute key %q", a.Key)
		}
		attrs[a.Key] = a.Value
	}
	return attrs, lr.Body.StringValue, lr.SeverityText, lr.SeverityNumber
}

// TestOtelExporterLossless_EveryKeyBecomesAttribute pins that every canonical
// key produces an attribute of the correct native type. A future edit that
// drops any field, correlation ID, or user fails this test.
func TestOtelExporterLossless_EveryKeyBecomesAttribute(t *testing.T) {
	rec := canonicalRecord()
	attrs, body, sevText, sevNum := decodeOtelBody(t, rec)

	// Body is the full serialized Ion JSONL line. Verify it parses as JSON
	// and contains the msg field rather than just being the bare msg string.
	var parsed map[string]any
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Errorf("body is not valid JSON: %q: %v", body, err)
	} else {
		if got, ok := parsed["msg"].(string); !ok || got != "session started" {
			t.Errorf("body[\"msg\"] = %v, want \"session started\"", parsed["msg"])
		}
		if got, ok := parsed["component"].(string); !ok || got != "engine" {
			t.Errorf("body[\"component\"] = %v, want \"engine\"", parsed["component"])
		}
	}
	if sevText != "INFO" || sevNum != 9 {
		t.Errorf("severity = %q/%d, want INFO/9", sevText, sevNum)
	}

	// Expected attribute set: component, tag, the three correlation IDs, user,
	// and every fields key (run_id included). This is the canonical set; a
	// missing or extra key fails.
	wantKeys := []string{
		"component", "tag",
		"session_id", "conversation_id", "trace_id", "user",
		"run_id", "model", "turn", "cost_usd", "cache_hit",
		"duration_ms", "nested", "list", "whole_float",
	}
	if len(attrs) != len(wantKeys) {
		t.Errorf("attribute count = %d, want %d; got keys %v", len(attrs), len(wantKeys), keysOf(attrs))
	}
	for _, k := range wantKeys {
		if _, ok := attrs[k]; !ok {
			t.Errorf("missing attribute %q (lossless requires every canonical key)", k)
		}
	}

	// Native typing assertions.
	assertStr(t, attrs, "component", "engine")
	assertStr(t, attrs, "tag", "session")
	assertStr(t, attrs, "session_id", "sess-abc")
	assertStr(t, attrs, "conversation_id", "1780093348767-c1c03e998388")
	assertStr(t, attrs, "trace_id", "4bf92f3577b34da6a3ce929d0e0e4736")
	assertStr(t, attrs, "user", "user@example.com")
	// run_id rides inside fields but must still surface as its own attribute.
	assertStr(t, attrs, "run_id", "run-xyz")
	assertStr(t, attrs, "model", "claude-opus-4-5")
	// Integer scalar → intValue "3".
	assertInt(t, attrs, "turn", "3")
	// duration_ms integer → intValue "42".
	assertInt(t, attrs, "duration_ms", "42")
	// Non-integer float → doubleValue.
	assertDouble(t, attrs, "cost_usd", 0.0123)
	// bool → boolValue.
	assertBool(t, attrs, "cache_hit", true)
	// Whole-valued float → intValue "5" (spool round-trip stability).
	assertInt(t, attrs, "whole_float", "5")
	// Nested object → JSON-stringified stringValue.
	assertJSONStr(t, attrs, "nested", map[string]any{"a": float64(1), "b": "two"})
	// Array → JSON-stringified stringValue.
	assertJSONStr(t, attrs, "list", []any{"x", "y", "z"})
}

// TestOtelExporterLossless_OmitsAbsentCorrelation verifies the empty-string
// rule: absent correlation IDs and user produce no attribute (not an empty
// one).
func TestOtelExporterLossless_OmitsAbsentCorrelation(t *testing.T) {
	rec := egressRecord{
		Ts:        "2024-11-15T22:04:05.123456789Z",
		Level:     "WARN",
		Msg:       "socket already exists",
		Component: "engine",
		Tag:       "server",
		Fields:    map[string]any{"path": "/tmp/x.sock"},
	}
	attrs, _, sevText, sevNum := decodeOtelBody(t, rec)

	for _, absent := range []string{"session_id", "conversation_id", "trace_id", "user"} {
		if _, ok := attrs[absent]; ok {
			t.Errorf("attribute %q must be omitted when not in scope", absent)
		}
	}
	// component, tag, and the one fields key must be present.
	assertStr(t, attrs, "component", "engine")
	assertStr(t, attrs, "tag", "server")
	assertStr(t, attrs, "path", "/tmp/x.sock")
	if sevText != "WARN" || sevNum != 13 {
		t.Errorf("severity = %q/%d, want WARN/13", sevText, sevNum)
	}
}

// TestOtelExporterLossless_SpoolRoundTripStable verifies that a record whose
// fields survived a JSON spool round-trip (all numbers decode to float64)
// serializes to the identical OTLP attribute types as the live record. This is
// the reason whole-valued floats are promoted to intValue.
func TestOtelExporterLossless_SpoolRoundTripStable(t *testing.T) {
	live := canonicalRecord()

	// Simulate the spool round-trip: marshal then unmarshal, which turns every
	// numeric field into float64.
	b, err := json.Marshal(live)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var roundTripped egressRecord
	if err := json.Unmarshal(b, &roundTripped); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	liveAttrs, _, _, _ := decodeOtelBody(t, live)
	rtAttrs, _, _, _ := decodeOtelBody(t, roundTripped)

	if len(liveAttrs) != len(rtAttrs) {
		t.Fatalf("attribute count drift after spool round-trip: live=%d rt=%d", len(liveAttrs), len(rtAttrs))
	}
	for k, lv := range liveAttrs {
		rv, ok := rtAttrs[k]
		if !ok {
			t.Errorf("key %q lost after spool round-trip", k)
			continue
		}
		if !attrValEqual(lv, rv) {
			t.Errorf("key %q type/value drift: live=%+v rt=%+v", k, lv, rv)
		}
	}
}

// TestOtelExporterLevels pins the level→severity mapping for every level.
func TestOtelExporterLevels(t *testing.T) {
	cases := []struct {
		level string
		num   int
	}{
		{"TRACE", 1}, {"DEBUG", 5}, {"INFO", 9}, {"WARN", 13}, {"ERROR", 17},
	}
	for _, c := range cases {
		rec := egressRecord{Ts: "2024-11-15T22:04:05Z", Level: c.level, Msg: "m", Component: "engine", Tag: "t"}
		_, _, sevText, sevNum := decodeOtelBody(t, rec)
		if sevText != c.level || sevNum != c.num {
			t.Errorf("level %s: got %q/%d, want %s/%d", c.level, sevText, sevNum, c.level, c.num)
		}
	}
}

// TestOtelBodyIsFullJSONL verifies the body is the complete serialized Ion JSONL
// line, not just the bare msg string. Alloy's ion_otlp_unwrap pipeline extracts
// the body and rewrites the Loki line to it — so the stored Loki line must be
// parseable JSON for `| json` dashboard queries to work.
func TestOtelBodyIsFullJSONL(t *testing.T) {
	rec := canonicalRecord()
	body := otlpLogBody(rec)
	var parsed map[string]any
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Errorf("otlpLogBody produced non-JSON: %q: %v", body, err)
		return
	}
	// Must contain the canonical top-level fields.
	for _, key := range []string{"ts", "level", "msg", "component", "tag"} {
		if _, ok := parsed[key]; !ok {
			t.Errorf("otlpLogBody missing top-level key %q", key)
		}
	}
	// Must NOT be just the bare msg string.
	if body == rec.Msg {
		t.Errorf("otlpLogBody = bare msg string %q; want full JSONL", rec.Msg)
	}
}

// TestEgressUserSeam verifies the SetEgressUser seam populates resolvedEgressUser
// and clears back to empty (the omit-when-empty default).
func TestEgressUserSeam(t *testing.T) {
	t.Cleanup(func() { SetEgressUser("") })
	if got := resolvedEgressUser(); got != "" {
		t.Errorf("default resolvedEgressUser = %q, want empty", got)
	}
	SetEgressUser("alice@example.com")
	if got := resolvedEgressUser(); got != "alice@example.com" {
		t.Errorf("resolvedEgressUser = %q after set, want alice@example.com", got)
	}
	SetEgressUser("")
	if got := resolvedEgressUser(); got != "" {
		t.Errorf("resolvedEgressUser = %q after clear, want empty", got)
	}
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

func keysOf(m map[string]otlpLogAttrVal) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	return ks
}

func assertStr(t *testing.T, attrs map[string]otlpLogAttrVal, key, want string) {
	t.Helper()
	v, ok := attrs[key]
	if !ok {
		t.Errorf("attribute %q missing", key)
		return
	}
	if v.StringValue == nil {
		t.Errorf("attribute %q not a stringValue: %+v", key, v)
		return
	}
	if *v.StringValue != want {
		t.Errorf("attribute %q stringValue = %q, want %q", key, *v.StringValue, want)
	}
}

func assertInt(t *testing.T, attrs map[string]otlpLogAttrVal, key, want string) {
	t.Helper()
	v, ok := attrs[key]
	if !ok {
		t.Errorf("attribute %q missing", key)
		return
	}
	if v.IntValue == nil {
		t.Errorf("attribute %q not an intValue: %+v", key, v)
		return
	}
	if *v.IntValue != want {
		t.Errorf("attribute %q intValue = %q, want %q", key, *v.IntValue, want)
	}
}

func assertDouble(t *testing.T, attrs map[string]otlpLogAttrVal, key string, want float64) {
	t.Helper()
	v, ok := attrs[key]
	if !ok {
		t.Errorf("attribute %q missing", key)
		return
	}
	if v.DoubleValue == nil {
		t.Errorf("attribute %q not a doubleValue: %+v", key, v)
		return
	}
	if *v.DoubleValue != want {
		t.Errorf("attribute %q doubleValue = %v, want %v", key, *v.DoubleValue, want)
	}
}

func assertBool(t *testing.T, attrs map[string]otlpLogAttrVal, key string, want bool) {
	t.Helper()
	v, ok := attrs[key]
	if !ok {
		t.Errorf("attribute %q missing", key)
		return
	}
	if v.BoolValue == nil {
		t.Errorf("attribute %q not a boolValue: %+v", key, v)
		return
	}
	if *v.BoolValue != want {
		t.Errorf("attribute %q boolValue = %v, want %v", key, *v.BoolValue, want)
	}
}

func assertJSONStr(t *testing.T, attrs map[string]otlpLogAttrVal, key string, want any) {
	t.Helper()
	v, ok := attrs[key]
	if !ok {
		t.Errorf("attribute %q missing", key)
		return
	}
	if v.StringValue == nil {
		t.Errorf("attribute %q not a stringValue (nested must JSON-stringify): %+v", key, v)
		return
	}
	var got any
	if err := json.Unmarshal([]byte(*v.StringValue), &got); err != nil {
		t.Errorf("attribute %q value is not valid JSON: %q", key, *v.StringValue)
		return
	}
	wb, _ := json.Marshal(want)
	gb, _ := json.Marshal(got)
	if string(wb) != string(gb) {
		t.Errorf("attribute %q JSON = %s, want %s", key, gb, wb)
	}
}

func attrValEqual(a, b otlpLogAttrVal) bool {
	strEq := func(x, y *string) bool {
		if x == nil || y == nil {
			return x == y
		}
		return *x == *y
	}
	if !strEq(a.StringValue, b.StringValue) {
		return false
	}
	if !strEq(a.IntValue, b.IntValue) {
		return false
	}
	if (a.BoolValue == nil) != (b.BoolValue == nil) {
		return false
	}
	if a.BoolValue != nil && *a.BoolValue != *b.BoolValue {
		return false
	}
	if (a.DoubleValue == nil) != (b.DoubleValue == nil) {
		return false
	}
	if a.DoubleValue != nil && *a.DoubleValue != *b.DoubleValue {
		return false
	}
	return true
}
