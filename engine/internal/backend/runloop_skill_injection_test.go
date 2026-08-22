package backend

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestInjectSkillListingDeltaInitialThenNoRepeat(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()
	skills.RegisterSkill(&skills.Skill{Name: "alpha", Description: "Alpha work"})
	conv := conversation.CreateConversation("skill-list", "", "")
	conversation.AddUserMessage(conv, "task")
	opts := types.RunOptions{SessionKey: "skill-list"}
	injectSkillListingDelta(conv, opts, RunHooks{})
	if len(conv.Messages) != 1 {
		t.Fatalf("initial listing messages = %d, want inbound carrier only", len(conv.Messages))
	}
	injectSkillListingDelta(conv, opts, RunHooks{})
	if len(conv.Messages) != 1 {
		t.Fatalf("listing repeated: %d messages", len(conv.Messages))
	}
}

func TestInjectSkillListingDeltaOnlyAddsNewSkills(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()
	skills.RegisterSkill(&skills.Skill{Name: "alpha"})
	conv := conversation.CreateConversation("skill-delta", "", "")
	conversation.AddUserMessage(conv, "first")
	opts := types.RunOptions{SessionKey: "skill-delta"}
	injectSkillListingDelta(conv, opts, RunHooks{})
	skills.RegisterSkill(&skills.Skill{Name: "beta"})
	conversation.AddUserMessage(conv, "second")
	injectSkillListingDelta(conv, opts, RunHooks{})
	if len(conv.Messages) != 2 {
		t.Fatalf("messages = %d, want initial plus delta", len(conv.Messages))
	}
	blocks := conv.Messages[1].Content.([]types.LlmContentBlock)
	if len(blocks) != 2 || len(blocks[1].SkillNames) != 1 || blocks[1].SkillNames[0] != "beta" {
		t.Fatalf("wrong delta: %#v", blocks)
	}
}

func TestInjectSkillListingRespectsConfigAndHook(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()
	skills.RegisterSkill(&skills.Skill{Name: "alpha"})
	conv := conversation.CreateConversation("skill-config", "", "")
	conversation.AddUserMessage(conv, "task")
	injectSkillListingDelta(conv, types.RunOptions{DisableSkillSystemPrompt: true}, RunHooks{})
	if len(conv.Messages) != 1 {
		t.Fatal("config suppression changed inbound message")
	}
	blocks := conv.Messages[0].Content.([]types.LlmContentBlock)
	if len(blocks) != 1 || blocks[0].Type != "text" {
		t.Fatalf("config suppression injected listing: %#v", blocks)
	}
	injectSkillListingDelta(conv, types.RunOptions{}, RunHooks{OnSystemInject: func(kind, text string, _, _ int) (string, bool) {
		if kind != "skill_listing" || !strings.Contains(text, "alpha") {
			t.Fatalf("unexpected hook payload kind=%q text=%q", kind, text)
		}
		return "harness listing", false
	}})
	blocks = conv.Messages[0].Content.([]types.LlmContentBlock)
	if blocks[1].Text != "harness listing" {
		t.Fatalf("hook replacement lost: %#v", blocks[0])
	}
}

func TestBuildSystemPromptDoesNotRepeatSkillListing(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()
	skills.RegisterSkill(&skills.Skill{Name: "alpha"})
	got := buildSystemPrompt(&types.RunOptions{SystemPrompt: "base"}, &conversation.Conversation{}, RunHooks{}, "request", nil)
	if strings.Contains(got, "Available Skills") {
		t.Fatalf("listing must be conversation delta, not system prompt: %q", got)
	}
}
