package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestCountUserPrompts_ExcludesNonPrompts is the load-bearing regression test
// for the conversation-lifetime turn count. It asserts the exact locked
// predicate: real typed prompts (including slash-command turns) count; tool
// returns, context injections, DisplayOnly entries, assistant messages, and
// non-message entries (agent_dispatch, plan_marker, steer_marker, compaction)
// do NOT. Before this helper existed the drawer showed the per-run turn count
// (TaskCompleteEvent.NumTurns), which reflected only the last prompt's model
// round-trips; this test pins the lifetime semantic instead.
func TestCountUserPrompts_ExcludesNonPrompts(t *testing.T) {
	conv := CreateConversation("count-1", "system", "model")

	// 1. Real typed prompt — COUNTS.
	AddUserMessage(conv, "first real prompt")

	// Assistant reply — never a prompt.
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "reply"}}, types.LlmUsage{})

	// 2. Tool return: role=user, content is a tool_result block — EXCLUDED.
	AddToolResults(conv, []ToolResultEntry{{ToolUseID: "t1", Content: "tool output"}})

	// 3. Context injection: role=user, single context_injection block — EXCLUDED.
	AddContextInjectionMessage(conv, []string{"/repo/AGENTS.md"}, "# Context from /repo/AGENTS.md\nbody", false)

	// 4. Second real typed prompt — COUNTS.
	AddUserMessage(conv, "second real prompt")

	// 5. Slash-command turn: display entry carries a text block, provenance set,
	//    not DisplayOnly — COUNTS.
	AddUserMessageWithInvocation(conv, "expanded body the model sees", SlashInvocation{
		Command: "/diagram",
		Args:    "the thing",
		Source:  "ion",
	})

	// 6. DisplayOnly user entry: shown in scrollback but never a consumed
	//    prompt — EXCLUDED. Appended directly since AddUserMessage never sets
	//    DisplayOnly.
	AppendEntry(conv, EntryMessage, MessageData{
		Role:        "user",
		Content:     []types.LlmContentBlock{{Type: "text", Text: "/context fork raw invocation"}},
		DisplayOnly: true,
	})

	// 7. Non-message entries — never prompts.
	AppendEntry(conv, EntrySteerMarker, SteerMarkerData{MessageLength: 10})
	AppendEntry(conv, EntryAgentDispatch, AgentDispatchData{AgentName: "dev", AgentID: "a1", Status: "done"})

	// 8. Mixed message: a role=user entry carrying BOTH a text block and a
	//    tool_result block. This is the case the tool_result guard is
	//    load-bearing for: hasText is true, but the presence of a tool_result
	//    block marks it a tool-return turn, so it must be EXCLUDED. Without the
	//    `hasToolResult ||` guard this would wrongly count.
	AppendEntry(conv, EntryMessage, MessageData{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "text", Text: "here is the result"},
			{Type: "tool_result", ToolUseID: "t2", Content: "output"},
		},
	})

	got := CountUserPrompts(conv)
	const want = 3 // two plain prompts + one slash-command prompt
	if got != want {
		t.Fatalf("CountUserPrompts = %d, want %d (only real typed prompts count; tool results, context injections, DisplayOnly, assistant, and non-message entries must be excluded)", got, want)
	}
}

// TestCountUserPrompts_NilAndEmpty guards the boundary cases: a nil
// conversation and a conversation with no tree (no leaf) both return 0.
func TestCountUserPrompts_NilAndEmpty(t *testing.T) {
	if n := CountUserPrompts(nil); n != 0 {
		t.Errorf("CountUserPrompts(nil) = %d, want 0", n)
	}
	// A conversation with no entries / no leaf returns 0 (getContextPathEntries
	// returns nil when LeafID is nil).
	conv := &Conversation{ID: "empty", Version: CurrentVersion}
	if n := CountUserPrompts(conv); n != 0 {
		t.Errorf("CountUserPrompts(no-leaf) = %d, want 0", n)
	}
}

// TestCountUserPrompts_ActiveBranchOnly verifies the count walks the active
// leaf path, not the full entry set: an abandoned branch's prompts do not
// inflate the lifetime count. This mirrors flattenEntries, which renders the
// same active-path scrollback the drawer count must agree with.
func TestCountUserPrompts_ActiveBranchOnly(t *testing.T) {
	conv := CreateConversation("count-branch", "system", "model")

	// Root prompt.
	root := AddUserMessage(conv, "root prompt")
	if root == nil {
		t.Fatal("expected a root entry")
	}
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "r"}}, types.LlmUsage{})

	// Branch A: one extra prompt on the active leaf.
	AddUserMessage(conv, "branch A prompt")

	// Now branch off the root: move the leaf back and add a different prompt.
	// This abandoned-then-reactivated shape proves only the CURRENT leaf path
	// is counted.
	if _, err := Branch(conv, root.ID); err != nil {
		t.Fatalf("Branch: %v", err)
	}
	AddUserMessage(conv, "branch B prompt")

	// Active path = root prompt + branch B prompt = 2. Branch A's prompt is on
	// an abandoned sibling and must NOT count.
	got := CountUserPrompts(conv)
	if got != 2 {
		t.Fatalf("CountUserPrompts = %d, want 2 (active leaf path only; abandoned branch prompts excluded)", got)
	}
}
