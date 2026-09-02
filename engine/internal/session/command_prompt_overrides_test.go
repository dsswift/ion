package session

import "testing"

func TestMergeCommandPromptOverridesPreservesClientContext(t *testing.T) {
	clientBoundary := false
	extensionBoundary := true
	command := &PromptOverrides{
		Model:                              "standard",
		AppendSystemPrompt:                 "desktop guidance",
		PlanFilePath:                       "/plans/active.md",
		TemporaryAutoFromPlan:              true,
		ThinkingEffort:                     "low",
		DisplayText:                        "visible answers",
		SlashModelTierApplyMidConversation: &clientBoundary,
	}
	extension := &PromptOverrides{
		Model:                              "fast",
		InjectionKind:                      "slash_command",
		CommandContinuation:                true,
		SlashModelTierApplyMidConversation: &extensionBoundary,
	}

	got := mergeCommandPromptOverrides(command, extension)
	if got.Model != "fast" || got.AppendSystemPrompt != "desktop guidance" {
		t.Fatalf("merged options = %+v", got)
	}
	if !got.TemporaryAutoFromPlan || got.PlanFilePath != "/plans/active.md" || got.ThinkingEffort != "low" || got.DisplayText != "visible answers" {
		t.Fatalf("plan/run options were lost: %+v", got)
	}
	if !got.CommandContinuation || got.InjectionKind != "slash_command" {
		t.Fatalf("extension continuation options were lost: %+v", got)
	}
	if got.SlashModelTierApplyMidConversation == nil || !*got.SlashModelTierApplyMidConversation {
		t.Fatalf("extension boundary override did not win: %+v", got)
	}
}
