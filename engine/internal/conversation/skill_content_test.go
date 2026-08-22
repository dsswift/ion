package conversation

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestAddToolResultsPersistsSkillBodyOutsideToolResult(t *testing.T) {
	conv := CreateConversation("skill-lifecycle", "", "")
	AddAssistantMessageNoUsage(conv, []types.LlmContentBlock{{Type: "tool_use", ID: "skill-call", Name: "Skill"}})
	AddToolResults(conv, []ToolResultEntry{{
		ToolUseID: "skill-call", Content: "Loaded skill \"graphify\". Follow its instructions for this task.",
		SkillInvocation: &types.SkillInvocation{Name: "graphify", Source: "/tmp/graphify/SKILL.md", Content: "full skill body", InvokedAt: 42},
	}})
	if len(conv.Messages) != 2 {
		t.Fatalf("message count = %d, want 2", len(conv.Messages))
	}
	blocks := conv.Messages[1].Content.([]types.LlmContentBlock)
	if len(blocks) != 2 || blocks[0].Type != "tool_result" || blocks[1].Type != SkillContentBlockType {
		t.Fatalf("unexpected blocks: %#v", blocks)
	}
	if blocks[0].Content == "full skill body" {
		t.Fatal("full body must not remain opaque tool result")
	}
	if !strings.Contains(blocks[1].Text, "full skill body") || blocks[1].SkillName != "graphify" {
		t.Fatalf("typed body lost: %#v", blocks[1])
	}
	if got := CountUserPrompts(conv); got != 0 {
		t.Fatalf("skill carrier counted as user prompt: %d", got)
	}
}

func TestAppendSkillListingUsesInboundUserCarrier(t *testing.T) {
	conv := CreateConversation("listing", "", "")
	AddUserMessage(conv, "user task")
	if !AppendSkillListingToLastUser(conv, []string{"alpha", "beta"}, "listing text") {
		t.Fatal("expected listing append")
	}
	if len(conv.Messages) != 1 {
		t.Fatalf("listing must not create second user message: %d", len(conv.Messages))
	}
	seen := AnnouncedSkillNames(conv)
	if !seen["alpha"] || !seen["beta"] || len(seen) != 2 {
		t.Fatalf("unexpected announced skills: %#v", seen)
	}
	if got := CountUserPrompts(conv); got != 1 {
		t.Fatalf("listing changed prompt count: %d", got)
	}
}

func TestSkillListingDedupIgnoresUserProse(t *testing.T) {
	conv := CreateConversation("listing-prose", "", "")
	AddUserMessage(conv, "alpha beta")
	seen := AnnouncedSkillNames(conv)
	if len(seen) != 0 {
		t.Fatalf("user prose must not affect structural dedupe: %#v", seen)
	}
}

func TestBoundRestoredSkillsUsesNewestFirstAndBudgets(t *testing.T) {
	body := strings.Repeat("x", MaxRestoredSkillTokensPerSkill*4+100)
	skills := []types.SkillInvocation{
		{Name: "new", Content: body, InvokedAt: 3},
		{Name: "middle", Content: strings.Repeat("m", MaxRestoredSkillTokensPerSkill*4), InvokedAt: 2},
		{Name: "old", Content: strings.Repeat("o", MaxRestoredSkillTokensPerSkill*4), InvokedAt: 1},
	}
	got := BoundRestoredSkills(skills)
	if len(got) != 3 || got[0].Name != "new" || !strings.Contains(got[0].Content, skillTruncationMarker) {
		t.Fatalf("unexpected bounded skills: %#v", got)
	}
	tokens := 0
	for _, skill := range got {
		tokens += estimateSkillTokens(skill.Content)
	}
	if tokens > MaxRestoredSkillTokensTotal {
		t.Fatalf("restoration exceeds total budget: %d", tokens)
	}
}

func TestCompactBoundaryRestoresSkillsToContext(t *testing.T) {
	skill := types.SkillInvocation{Name: "graphify", Content: "use graph", InvokedAt: 9}
	msg := BuildCompactBoundaryMessage(CompactMeta{RestoredSkills: []types.SkillInvocation{skill}})
	blocks := msg.Content.([]types.LlmContentBlock)
	if len(blocks) != 2 || blocks[1].Type != SkillContentBlockType || blocks[1].SkillName != skill.Name {
		t.Fatalf("boundary restoration missing: %#v", blocks)
	}
}
