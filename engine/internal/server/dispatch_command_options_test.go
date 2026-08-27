package server

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestPromptOverridesFromCommandPreservesRunOptions(t *testing.T) {
	cmd := &protocol.ClientCommand{
		Key:                   "tab-1",
		Model:                 "standard",
		AppendSystemPrompt:    "guidance",
		ThinkingEffort:        "low",
		PlanFilePath:          "/plans/active.md",
		TemporaryAutoFromPlan: true,
		DisplayText:           "visible answers",
		Attachments: []types.ImageAttachment{{
			MediaType: "application/pdf",
			Data:      "encoded",
		}},
	}

	got := promptOverridesFromCommand(cmd)
	if got.Model != cmd.Model || got.AppendSystemPrompt != cmd.AppendSystemPrompt || got.ThinkingEffort != cmd.ThinkingEffort {
		t.Fatalf("ordinary run options were not preserved: %+v", got)
	}
	if got.PlanFilePath != cmd.PlanFilePath || !got.TemporaryAutoFromPlan || got.DisplayText != cmd.DisplayText {
		t.Fatalf("plan workflow options were not preserved: %+v", got)
	}
	if len(got.Attachments) != 1 || got.Attachments[0].MediaType != "application/pdf" {
		t.Fatalf("attachments were not preserved: %+v", got.Attachments)
	}
}
