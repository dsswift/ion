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
	h.SetPersistentRecall(func(name, reason string) (bool, error) {
		gotName, gotReason = name, reason
		return true, nil
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
