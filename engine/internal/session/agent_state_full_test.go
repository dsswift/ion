package session

import (
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestGetAgentState_ReturnsUnclampedFullFidelitySnapshot(t *testing.T) {
	mgr := NewManager(newMockBackend())
	defer mgr.Shutdown()
	mgr.SetHeartbeatInterval(10 * time.Second)
	key := "full-agent-state"
	_, _ = mgr.StartSession(key, defaultConfig())

	mgr.mu.RLock()
	s := mgr.sessions[key]
	mgr.mu.RUnlock()
	s.agents.AppendState(types.AgentStateUpdate{Name: "agent", Status: "done", Metadata: map[string]any{
		"displayName": "Agent", "lastWork": strings.Repeat("x", 8192), "dispatches": []any{},
	}})

	for i := 0; i < 60; i++ {
		s.agents.UpdateState("agent", func(state *types.AgentStateUpdate) {
			state.Metadata["dispatches"] = append(state.Metadata["dispatches"].([]any), map[string]any{"id": string(rune('a' + i)), "status": "done"})
		})
	}

	states := mgr.GetAgentState(key)
	if len(states) != 1 {
		t.Fatalf("full response agents = %d, want 1", len(states))
	}
	if value := states[0].Metadata["lastWork"].(string); len(value) != 8192 {
		t.Fatalf("full response clamped lastWork to %d bytes", len(value))
	}
	if dispatches := states[0].Metadata["dispatches"].([]any); len(dispatches) != 60 {
		t.Fatalf("full response retained %d dispatches, want 60", len(dispatches))
	}
}
