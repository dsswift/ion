package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func hasTool(defs []types.LlmToolDef, name string) bool {
	for _, td := range defs {
		if td.Name == name {
			return true
		}
	}
	return false
}

// The API backend must offer TodoWrite to the model. This is the capability the
// delegated-CLI backends bring natively (Claude Code's own task list) and that
// the API runloop previously lacked, leaving the desktop task-list panel empty
// for every API-backend conversation.
func TestBuildToolDefsIncludesTodoWrite(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "test"}
	opts := types.RunOptions{}
	provider := &mockLlmProvider{id: "anthropic"}

	toolDefs, _ := b.buildToolDefs(run, opts, provider)
	if !hasTool(toolDefs, "TodoWrite") {
		t.Error("TodoWrite absent from API-backend tool defs")
	}
}

// TodoWrite is PlanModeSafe, so it must survive the plan-mode tool filter — a
// checklist is useful while planning and the tool mutates nothing.
func TestBuildToolDefsKeepsTodoWriteInPlanMode(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "test", planMode: true}
	opts := types.RunOptions{PlanMode: true}
	provider := &mockLlmProvider{id: "anthropic"}

	toolDefs, _ := b.buildToolDefs(run, opts, provider)
	if !hasTool(toolDefs, "TodoWrite") {
		t.Error("TodoWrite filtered out in plan mode despite PlanModeSafe")
	}
}
