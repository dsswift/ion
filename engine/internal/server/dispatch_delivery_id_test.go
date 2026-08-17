package server

import (
	"testing"
	"time"
)

func promptResultFlags(t *testing.T, lines []string) (bool, map[string]bool) {
	t.Helper()
	result := findResult(t, lines)
	if result == nil {
		t.Fatalf("send_prompt returned no result: %v", lines)
	}
	data, ok := result.Data.(map[string]any)
	if !ok {
		t.Fatalf("send_prompt data = %T, want object", result.Data)
	}
	flags := map[string]bool{}
	for _, key := range []string{"accepted", "alreadyAccepted"} {
		value, ok := data[key].(bool)
		if !ok {
			t.Fatalf("send_prompt data[%q] = %T, want bool", key, data[key])
		}
		flags[key] = value
	}
	return result.OK, flags
}

func TestDispatchSendPromptDeliveryIDIsIdempotent(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })
	startSession(t, conn, "delivery", "start-delivery")

	prompt := map[string]any{
		"cmd": "send_prompt", "key": "delivery", "text": "hello",
		"deliveryId": "delivery-1", "requestId": "prompt-1",
	}
	sendJSON(t, conn, prompt)
	ok, first := promptResultFlags(t, readLines(t, conn, 12, 2*time.Second))
	if !ok || !first["accepted"] || first["alreadyAccepted"] {
		t.Fatalf("first delivery result = ok:%t data:%v, want accepted", ok, first)
	}

	prompt["requestId"] = "prompt-2"
	sendJSON(t, conn, prompt)
	ok, duplicate := promptResultFlags(t, readLines(t, conn, 12, 2*time.Second))
	if !ok || duplicate["accepted"] || !duplicate["alreadyAccepted"] {
		t.Fatalf("duplicate delivery result = ok:%t data:%v, want already accepted", ok, duplicate)
	}

	mb.mu.Lock()
	started := len(mb.started)
	mb.mu.Unlock()
	if started != 1 {
		t.Fatalf("backend started %d runs, want 1", started)
	}
}
