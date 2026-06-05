package extension

import (
	"encoding/json"
	"testing"
	"time"
)

// ─── ext/get_context_usage ─────────────────────────────────────────────────

// contextUsagePayload returns a JSON-RPC request frame for ext/get_context_usage.
// The handler takes no params; we still build a `params:{}` to match the wire
// shape the TS SDK sends.
func contextUsagePayload(t *testing.T) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "ext/get_context_usage",
		"params":  map[string]interface{}{},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// TestExtGetContextUsage_ReturnsValueFromCtx verifies the happy path: a hook
// ctx with GetContextUsage wired returns a typed snapshot, and the handler
// marshals it onto the wire with the documented field names.
func TestExtGetContextUsage_ReturnsValueFromCtx(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	ctx := &Context{
		Cwd: "/tmp",
		GetContextUsage: func() *ContextUsage {
			return &ContextUsage{Percent: 42, Tokens: 84000, Cost: 0.123}
		},
	}
	h.ctxStack.Push(ctx)

	h.handleExtRequest("ext/get_context_usage", 1, contextUsagePayload(t))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected object result, got %v", resp["result"])
	}
	if got := result["percent"]; got != float64(42) {
		t.Errorf("percent = %v, want 42", got)
	}
	if got := result["tokens"]; got != float64(84000) {
		t.Errorf("tokens = %v, want 84000", got)
	}
	// Cost is float64 on the wire; tolerate JSON's float round-trip.
	if got, _ := result["cost"].(float64); got < 0.122 || got > 0.124 {
		t.Errorf("cost = %v, want ~0.123", got)
	}
}

// TestExtGetContextUsage_ReturnsNullWhenUnwired verifies that with no hook ctx
// the handler responds with a null result (not an error). Extensions loaded
// outside a session see this and can branch.
func TestExtGetContextUsage_ReturnsNullWhenUnwired(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	// No ctx attached.

	h.handleExtRequest("ext/get_context_usage", 1, contextUsagePayload(t))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	// JSON `null` decodes to Go nil; the key must be present but the value nil.
	if _, present := resp["result"]; !present {
		t.Fatalf("expected `result` key in response, got %v", resp)
	}
	if resp["result"] != nil {
		t.Errorf("expected null result, got %v", resp["result"])
	}
}

// TestExtGetContextUsage_ReturnsNullWhenGetterReturnsNil verifies that a ctx
// with a wired-but-nil-returning getter (e.g. no active run mid-extension-load)
// still surfaces as a null wire response rather than a misleading zero-value
// object.
func TestExtGetContextUsage_ReturnsNullWhenGetterReturnsNil(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	ctx := &Context{
		Cwd: "/tmp",
		GetContextUsage: func() *ContextUsage {
			return nil
		},
	}
	h.ctxStack.Push(ctx)

	h.handleExtRequest("ext/get_context_usage", 1, contextUsagePayload(t))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	if resp["result"] != nil {
		t.Errorf("expected null result, got %v", resp["result"])
	}
}

// ─── ext/search_history ────────────────────────────────────────────────────

// searchHistoryPayload returns a JSON-RPC request frame for ext/search_history.
func searchHistoryPayload(t *testing.T, query string, maxResults int) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "ext/search_history",
		"params": map[string]interface{}{
			"query":      query,
			"maxResults": maxResults,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// TestExtSearchHistory_PassesThroughResults verifies the happy path: the
// handler invokes ctx.SearchHistory with the parsed query/maxResults, and
// the returned HistoryMatch slice round-trips through JSON intact.
func TestExtSearchHistory_PassesThroughResults(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	var capturedQuery string
	var capturedMax int
	ctx := &Context{
		Cwd: "/tmp",
		SearchHistory: func(query string, maxResults int) ([]HistoryMatch, error) {
			capturedQuery = query
			capturedMax = maxResults
			return []HistoryMatch{
				{Index: 3, Role: "user", Type: "text", Snippet: "ping the api"},
				{Index: 7, Role: "assistant", Type: "tool_use", Snippet: "Bash(...)", ToolName: "Bash", ToolUseID: "tu_abc"},
			}, nil
		},
	}
	h.ctxStack.Push(ctx)

	h.handleExtRequest("ext/search_history", 1, searchHistoryPayload(t, "api", 25))

	if capturedQuery != "api" {
		t.Errorf("query = %q, want %q", capturedQuery, "api")
	}
	if capturedMax != 25 {
		t.Errorf("maxResults = %d, want 25", capturedMax)
	}

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	arr, ok := resp["result"].([]interface{})
	if !ok {
		t.Fatalf("expected array result, got %v", resp["result"])
	}
	if len(arr) != 2 {
		t.Fatalf("expected 2 matches, got %d", len(arr))
	}

	// Match 0: plain text snippet -- no tool fields.
	m0 := arr[0].(map[string]interface{})
	if got := m0["index"]; got != float64(3) {
		t.Errorf("match[0].index = %v, want 3", got)
	}
	if got := m0["role"]; got != "user" {
		t.Errorf("match[0].role = %v, want user", got)
	}
	if got := m0["type"]; got != "text" {
		t.Errorf("match[0].type = %v, want text", got)
	}
	if got := m0["snippet"]; got != "ping the api" {
		t.Errorf("match[0].snippet = %v, want %q", got, "ping the api")
	}
	// Match 1: tool segment -- toolName / toolUseId populated.
	m1 := arr[1].(map[string]interface{})
	if got := m1["toolName"]; got != "Bash" {
		t.Errorf("match[1].toolName = %v, want Bash", got)
	}
	if got := m1["toolUseId"]; got != "tu_abc" {
		t.Errorf("match[1].toolUseId = %v, want tu_abc", got)
	}
}

// TestExtSearchHistory_EmptyArrayWhenUnwired verifies the no-ctx path returns
// a wire `[]` rather than null. TS callers iterate the result; null would force
// every extension to guard with `?? []`.
func TestExtSearchHistory_EmptyArrayWhenUnwired(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	// No ctx attached.

	h.handleExtRequest("ext/search_history", 1, searchHistoryPayload(t, "anything", 5))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	arr, ok := resp["result"].([]interface{})
	if !ok {
		t.Fatalf("expected array result, got %v (type %T)", resp["result"], resp["result"])
	}
	if len(arr) != 0 {
		t.Errorf("expected empty array, got %d entries", len(arr))
	}
}

// TestExtSearchHistory_EmptyArrayWhenSearcherUnset verifies that a ctx with
// no SearchHistory closure (older session accessors / dispatched-agent ctx)
// also returns []. We never want a nil dereference to surface as an RPC error.
func TestExtSearchHistory_EmptyArrayWhenSearcherUnset(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	// ctx without SearchHistory wired -- mimics partial wiring (e.g. before
	// extcontext.NewExtContext ran).
	ctx := &Context{Cwd: "/tmp"}
	h.ctxStack.Push(ctx)

	h.handleExtRequest("ext/search_history", 1, searchHistoryPayload(t, "anything", 5))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	arr, ok := resp["result"].([]interface{})
	if !ok {
		t.Fatalf("expected array result, got %v", resp["result"])
	}
	if len(arr) != 0 {
		t.Errorf("expected empty array, got %d entries", len(arr))
	}
}

// TestExtSearchHistory_NilSliceMarshalsAsEmptyArray verifies that a searcher
// returning a nil []HistoryMatch (Go's "no matches" idiom) marshals as `[]`
// not `null`. Guards against a regression where nil-slice JSON encoding
// would force extensions to add a null check.
func TestExtSearchHistory_NilSliceMarshalsAsEmptyArray(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	ctx := &Context{
		Cwd: "/tmp",
		SearchHistory: func(_ string, _ int) ([]HistoryMatch, error) {
			return nil, nil
		},
	}
	h.ctxStack.Push(ctx)

	h.handleExtRequest("ext/search_history", 1, searchHistoryPayload(t, "x", 0))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	arr, ok := resp["result"].([]interface{})
	if !ok {
		t.Fatalf("expected array result, got %v", resp["result"])
	}
	if len(arr) != 0 {
		t.Errorf("expected empty array, got %d entries", len(arr))
	}
}
