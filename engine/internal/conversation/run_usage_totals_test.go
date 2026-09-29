package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestAddRunUsageTotals_HeaderOnly pins the split that lets a delegated-CLI run
// account for its tokens without corrupting occupancy: the run's cumulative
// figure reaches the header totals and no message.
func TestAddRunUsageTotals_HeaderOnly(t *testing.T) {
	conv := CreateConversation("1784000000000-c111111111c1", "system", "claude-fable-5-1")
	AddUserMessage(conv, "prompt")
	AddAssistantMessageNoUsage(conv, []types.LlmContentBlock{{Type: "text", Text: "answer"}}, "claude-fable-5-1")

	AddRunUsageTotals(conv, types.LlmUsage{
		InputTokens:              114,
		OutputTokens:             12176,
		CacheReadInputTokens:     443672,
		CacheCreationInputTokens: 93413,
	})

	if want := 114 + 443672 + 93413; conv.TotalInputTokens != want {
		t.Errorf("TotalInputTokens = %d, want %d", conv.TotalInputTokens, want)
	}
	if conv.TotalOutputTokens != 12176 {
		t.Errorf("TotalOutputTokens = %d, want 12176", conv.TotalOutputTokens)
	}
	for i, m := range conv.Messages {
		if m.Usage != nil {
			t.Errorf("message %d carries Usage; the run sum belongs on the header only", i)
		}
	}
	if got := GetContextUsage(conv, 1000000); !got.Estimated {
		t.Errorf("occupancy became API-derived after a header-only write: %+v", got)
	}
}

// TestAddRunUsageTotals_Accumulates confirms successive runs sum, matching the
// per-message header arithmetic in AddAssistantMessageWithEntryID. A delegated
// CLI reports once per run, so a multi-run conversation must add each report.
func TestAddRunUsageTotals_Accumulates(t *testing.T) {
	conv := CreateConversation("1784000000000-c222222222c2", "system", "claude-fable-5-1")

	AddRunUsageTotals(conv, types.LlmUsage{InputTokens: 10, OutputTokens: 5, CacheReadInputTokens: 100})
	AddRunUsageTotals(conv, types.LlmUsage{InputTokens: 20, OutputTokens: 7, CacheCreationInputTokens: 200})

	if want := 10 + 100 + 20 + 200; conv.TotalInputTokens != want {
		t.Errorf("TotalInputTokens = %d, want %d", conv.TotalInputTokens, want)
	}
	if conv.TotalOutputTokens != 12 {
		t.Errorf("TotalOutputTokens = %d, want 12", conv.TotalOutputTokens)
	}
}
