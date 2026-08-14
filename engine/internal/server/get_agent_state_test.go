package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestGetAgentState_ReturnsFullRosterOnlyToRequester(t *testing.T) {
	srv := newShortPathTestServer(t, newMockBackend())
	requester := dialServer(t, srv)
	defer requester.Close()
	observer := dialServer(t, srv)
	defer observer.Close()
	const key = "full-agent-state"
	startSession(t, requester, key, "start-full-agent-state")
	original := strings.Repeat("x", 8192)
	dispatches := make([]any, 60)
	for i := range dispatches {
		dispatches[i] = map[string]any{"id": string(rune('a' + i)), "status": "done"}
	}
	if ok := srv.SessionManager().TestAppendAgentState(key, types.AgentStateUpdate{Name: "agent", Status: "done", Metadata: map[string]any{"displayName": "Agent", "lastWork": original, "dispatches": dispatches}}); !ok {
		t.Fatal("failed to seed session agent state")
	}

	sendJSON(t, requester, map[string]any{"cmd": "get_agent_state", "key": key, "requestId": "full-roster"})
	result := findResult(t, readLines(t, requester, 8, time.Second))
	if result == nil || !result.OK {
		t.Fatalf("get_agent_state result = %#v", result)
	}
	raw, err := json.Marshal(result.Data)
	if err != nil {
		t.Fatalf("marshal data: %v", err)
	}
	var payload protocol.AgentStateResponse
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if len(payload.Agents) != 1 {
		t.Fatalf("agents = %d, want 1", len(payload.Agents))
	}
	if got := payload.Agents[0].Metadata["lastWork"].(string); got != original {
		t.Fatal("response was bounded instead of full fidelity")
	}
	if got := len(payload.Agents[0].Metadata["dispatches"].([]any)); got != 60 {
		t.Fatalf("dispatches = %d, want 60", got)
	}

	observer.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	lines := readLines(t, observer, 1, 100*time.Millisecond)
	for _, line := range lines {
		if strings.Contains(line, "full-roster") {
			t.Fatalf("full roster leaked to observer: %s", line)
		}
	}
}
