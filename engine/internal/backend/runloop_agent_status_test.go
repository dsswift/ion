package backend

import (
	"context"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestExecuteToolsAgentStatusReadsWithoutSpawning(t *testing.T) {
	spawnCalls := 0
	statusCalls := 0
	run := &activeRun{
		requestID: "agent-status-run",
		cfg: &RunConfig{
			AgentSpawner: func(context.Context, string, string, string, string, string) (string, error) {
				spawnCalls++
				return "unexpected", nil
			},
			AgentStatus: func() []tools.AgentStatusEntry {
				statusCalls++
				return []tools.AgentStatusEntry{{DispatchID: "dispatch-existing", Name: "worker", Status: "running", Depth: 1}}
			},
		},
	}
	backend := NewApiBackend()
	blocks := []types.LlmContentBlock{{Type: "tool_use", ID: "status-call", Name: tools.AgentStatusToolName, Input: map[string]any{}}}

	results, err := backend.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatalf("executeTools: %v", err)
	}
	if len(results) != 1 || results[0].IsError || !strings.Contains(results[0].Content, "dispatch-existing") {
		t.Fatalf("AgentStatus results = %#v", results)
	}
	if statusCalls != 1 {
		t.Fatalf("AgentStatus getter calls = %d, want 1", statusCalls)
	}
	if spawnCalls != 0 {
		t.Fatalf("AgentStatus spawned %d agents", spawnCalls)
	}
}
