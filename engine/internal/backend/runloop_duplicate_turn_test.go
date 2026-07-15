package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestInboundDuplicatesLeaf pins the duplicate-turn sentinel that fires the
// "user turn duplicates current leaf" WARN. The forensic case: the same slash
// invocation dispatched twice across a stop/restart recovery, persisting two
// identical user entries with no assistant turn between. The engine appends
// faithfully (suppression would be policy) but must detect the shape.
func TestInboundDuplicatesLeaf(t *testing.T) {
	conv := conversation.CreateConversation("dup-sentinel", "s", "m")

	// Empty conversation: nothing to duplicate.
	if inboundDuplicatesLeaf(conv, &types.RunOptions{Prompt: "/analyze"}) {
		t.Fatal("empty conversation flagged as duplicate")
	}

	// First dispatch of a resolved slash command persists the raw invocation.
	conversation.AddUserMessageWithInvocation(conv, "expanded body", conversation.SlashInvocation{
		Command: "/analyze",
		Source:  "ion",
	})

	// Identical re-dispatch → duplicate.
	if !inboundDuplicatesLeaf(conv, &types.RunOptions{Prompt: "expanded body", ResolvedSlashCommand: "/analyze"}) {
		t.Fatal("identical slash re-dispatch not flagged")
	}
	// Same command, different args → not a duplicate.
	if inboundDuplicatesLeaf(conv, &types.RunOptions{Prompt: "expanded", ResolvedSlashCommand: "/analyze", ResolvedSlashArgs: "x"}) {
		t.Fatal("different args flagged as duplicate")
	}

	// After an assistant turn the leaf is no longer a user entry.
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "done"}}, types.LlmUsage{})
	if inboundDuplicatesLeaf(conv, &types.RunOptions{Prompt: "expanded body", ResolvedSlashCommand: "/analyze"}) {
		t.Fatal("re-dispatch after assistant turn flagged as duplicate")
	}

	// Plain-prompt duplicates are detected too.
	conversation.AddUserMessage(conv, "again")
	if !inboundDuplicatesLeaf(conv, &types.RunOptions{Prompt: "again"}) {
		t.Fatal("identical plain prompt not flagged")
	}
}
