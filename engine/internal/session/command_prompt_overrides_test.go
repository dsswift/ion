package session

import "testing"

func TestMergeCommandPromptOverridesPreservesClientContext(t *testing.T) {
	command := &PromptOverrides{
		Model:                 "standard",
		AppendSystemPrompt:    "desktop guidance",
		PlanFilePath:          "/plans/active.md",
		TemporaryAutoFromPlan: true,
		ThinkingEffort:        "low",
	}
	extension := &PromptOverrides{
		Model:               "fast",
		InjectionKind:       "slash_command",
		CommandContinuation: true,
	}

	got := mergeCommandPromptOverrides(command, extension)
	if got.Model != "fast" || got.AppendSystemPrompt != "desktop guidance" {
		t.Fatalf("merged options = %+v", got)
	}
	if !got.TemporaryAutoFromPlan || got.PlanFilePath != "/plans/active.md" || got.ThinkingEffort != "low" {
		t.Fatalf("plan/run options were lost: %+v", got)
	}
	if !got.CommandContinuation || got.InjectionKind != "slash_command" {
		t.Fatalf("extension continuation options were lost: %+v", got)
	}
}
