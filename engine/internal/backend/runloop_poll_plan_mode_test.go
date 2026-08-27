package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestBuildToolDefsPlanModeAlwaysExcludesPoll(t *testing.T) {
	b := NewApiBackend()
	provider := &mockLlmProvider{id: "anthropic"}
	for _, tc := range []struct {
		name  string
		tools []string
	}{
		{name: "default"},
		{name: "custom list names Poll", tools: []string{"Read", "Poll"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run := &activeRun{requestID: "plan-no-poll", planMode: true, planFilePath: "/tmp/plan.md", cfg: &RunConfig{}}
			opts := types.RunOptions{PlanMode: true, PlanFilePath: "/tmp/plan.md", PlanModeTools: tc.tools}
			defs, _ := b.buildToolDefs(run, opts, provider)
			for _, def := range defs {
				if def.Name == "Poll" {
					t.Fatal("Poll must never be exposed in plan mode")
				}
			}
		})
	}
}
