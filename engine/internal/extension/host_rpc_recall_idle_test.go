package extension

import (
	"strconv"
	"testing"
	"time"
)

func TestAckDispatchLostCallsPersistentSinkAndIsIdempotent(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	var acknowledged []string
	h.SetPersistentAckDispatchLost(func(dispatchID string) {
		acknowledged = append(acknowledged, dispatchID)
	})
	payload := func(id int) []byte {
		return []byte(`{"jsonrpc":"2.0","id":` + strconv.Itoa(id) + `,"method":"ext/ack_dispatch_lost","params":{"dispatchId":"dispatch-1"}}`)
	}
	for id := 1; id <= 2; id++ {
		h.handleExtRequest("ext/ack_dispatch_lost", int64(id), payload(id))
		response := readResponse(t, ch, time.Second)
		result, ok := response["result"].(map[string]interface{})
		if !ok || result["ok"] != true {
			t.Fatalf("response = %#v, want {ok:true}", response)
		}
	}
	if got := len(acknowledged); got != 2 {
		t.Fatalf("acknowledgements = %d, want 2 idempotent sink calls", got)
	}
}

func TestAckDispatchLostRejectsEmptyDispatchID(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	h.SetPersistentAckDispatchLost(func(dispatchID string) {
		t.Fatal("sink must not be called with empty dispatchId")
	})
	raw := []byte(`{"jsonrpc":"2.0","id":1,"method":"ext/ack_dispatch_lost","params":{"dispatchId":""}}`)
	h.handleExtRequest("ext/ack_dispatch_lost", 1, raw)
	resp := readResponse(t, ch, time.Second)
	if _, ok := resp["error"]; !ok {
		t.Fatalf("expected error for empty dispatchId, got %#v", resp)
	}
}

func TestRecallAgentWorksWhenParentIdle(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	var gotName, gotReason string
	h.SetPersistentRecall(func(name, reason string) (RecallAgentResult, error) {
		gotName, gotReason = name, reason
		return RecallAgentResult{Found: true, Outcome: "recalled"}, nil
	})
	raw := []byte(`{"jsonrpc":"2.0","id":1,"method":"ext/recall_agent","params":{"name":"watchdog-agent","reason":"timeout"}}`)
	h.handleExtRequest("ext/recall_agent", 1, raw)
	response := readResponse(t, ch, time.Second)
	result, ok := response["result"].(map[string]interface{})
	if !ok || result["found"] != true {
		t.Fatalf("response = %#v, want {found:true}", response)
	}
	if gotName != "watchdog-agent" || gotReason != "timeout" {
		t.Fatalf("persistent recall = (%q, %q), want (watchdog-agent, timeout)", gotName, gotReason)
	}
}

func TestRecallMethodsRejectUnavailableAndMissingIdentity(t *testing.T) {
	for _, tc := range []struct {
		name   string
		method string
		params string
	}{
		{name: "agent unavailable", method: "ext/recall_agent", params: `{"name":"worker"}`},
		{name: "dispatch unavailable", method: "ext/recall_dispatch", params: `{"dispatchId":"dispatch-1"}`},
		{name: "agent missing name", method: "ext/recall_agent", params: `{}`},
		{name: "dispatch missing id", method: "ext/recall_dispatch", params: `{}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHost()
			ch := attachStdout(h)
			raw := []byte(`{"jsonrpc":"2.0","id":1,"method":"` + tc.method + `","params":` + tc.params + `}`)
			h.handleExtRequest(tc.method, 1, raw)
			response := readResponse(t, ch, time.Second)
			if _, ok := response["error"]; !ok {
				t.Fatalf("response = %#v, want error", response)
			}
		})
	}
}

// TestRecallAgentAmbiguousWireShape pins the ext/recall_agent response for an
// ambiguous name: found stays false, outcome is "ambiguous", and the matching
// dispatch IDs ride along so the caller can retry by ID.
func TestRecallAgentAmbiguousWireShape(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	h.SetPersistentRecall(func(name, reason string) (RecallAgentResult, error) {
		return RecallAgentResult{Outcome: "ambiguous", MatchingDispatchIDs: []string{"d-1", "d-2"}}, nil
	})
	raw := []byte(`{"jsonrpc":"2.0","id":1,"method":"ext/recall_agent","params":{"name":"worker"}}`)
	h.handleExtRequest("ext/recall_agent", 1, raw)
	response := readResponse(t, ch, time.Second)
	result, ok := response["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("response = %#v, want a result", response)
	}
	ids, _ := result["matchingDispatchIds"].([]interface{}) //nolint:errcheck // shape asserted below
	if result["found"] != false || result["outcome"] != "ambiguous" || len(ids) != 2 || ids[0] != "d-1" || ids[1] != "d-2" {
		t.Fatalf("result = %#v, want {found:false, outcome:ambiguous, matchingDispatchIds:[d-1 d-2]}", result)
	}
}

// TestRecallDispatchWireOutcomes pins ext/recall_dispatch: a completed race
// answers a result with the terminal entry, and an unauthorized recall stays a
// handler error that now carries the typed outcome in its data.
func TestRecallDispatchWireOutcomes(t *testing.T) {
	exitCode := 0
	h := NewHost()
	ch := attachStdout(h)
	h.SetPersistentRecallByID(func(dispatchID, reason string) (RecallDispatchResult, error) {
		if dispatchID == "finished" {
			return RecallDispatchResult{Outcome: "completed", Terminal: &DispatchHistoryEntry{DispatchID: "finished", Status: "done", ExitCode: &exitCode}}, nil
		}
		return RecallDispatchResult{Outcome: "unauthorized"}, nil
	})

	h.handleExtRequest("ext/recall_dispatch", 1, []byte(`{"jsonrpc":"2.0","id":1,"method":"ext/recall_dispatch","params":{"dispatchId":"finished"}}`))
	resp := readResponse(t, ch, time.Second)
	result, ok := resp["result"].(map[string]interface{})
	terminal, _ := result["terminal"].(map[string]interface{}) //nolint:errcheck // asserted below
	if !ok || result["found"] != false || result["outcome"] != "completed" || terminal["status"] != "done" {
		t.Fatalf("completed response = %#v", resp)
	}

	h.handleExtRequest("ext/recall_dispatch", 2, []byte(`{"jsonrpc":"2.0","id":2,"method":"ext/recall_dispatch","params":{"dispatchId":"sibling"}}`))
	resp = readResponse(t, ch, time.Second)
	rpcErr, ok := resp["error"].(map[string]interface{})
	data, _ := rpcErr["data"].(map[string]interface{}) //nolint:errcheck // asserted below
	if !ok || rpcErr["code"] != float64(-32000) || data["outcome"] != "unauthorized" {
		t.Fatalf("unauthorized response = %#v, want -32000 error with data.outcome unauthorized", resp)
	}
}
