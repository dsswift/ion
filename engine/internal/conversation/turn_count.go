package conversation

import (
	"github.com/dsswift/ion/engine/internal/types"
)

// CountUserPrompts returns the number of real user prompts across the
// conversation's lifetime — the human-meaningful "number of times the user
// prompted the agent." This is the conversation-lifetime turn count, distinct
// from the per-run turn counter (TaskCompleteEvent.NumTurns), which only
// reflects the model round-trips within the most recent run.
//
// The count walks the active leaf path (getContextPathEntries) rather than the
// full entry set, so an abandoned branch does not inflate the number: the
// result matches the scrollback the client renders (flattenEntries walks the
// same path). A conversation with no leaf (never persisted a tree) returns 0.
//
// A tree entry counts as one conversation turn if and only if ALL hold:
//
//  1. Type == EntryMessage — agent_dispatch / plan_marker / steer_marker /
//     compaction / model_change / label / custom entries are never prompts.
//  2. MessageData.Role == "user".
//  3. The entry is NOT DisplayOnly. A DisplayOnly entry (e.g. the `context:
//     fork` raw invocation recorded on the parent) is shown in scrollback but
//     was never a prompt the parent's model consumed.
//  4. The content carries at least one non-empty text block AND zero
//     tool_result blocks. This is the load-bearing filter: a real prompt is a
//     role=user message with typed text; a tool return is a role=user message
//     whose blocks are tool_result. If ANY block is tool_result, the message is
//     a tool return, not a prompt.
//  5. The content is not a context_injection message. A read-triggered nested
//     context injection (BuildContextInjectionMessage) rides as role=user but
//     is engine-injected, not typed. (Its only block is type context_injection,
//     so it already fails rule 4's text-block requirement; the explicit check
//     documents intent and guards a future injection that also carries text.)
//
// A slash-command turn (MessageData.SlashCommand set) IS a real prompt: the
// user typed "/foo". Its display entry carries a text block and no tool_result
// block and is not DisplayOnly, so it passes rules 1-5 with no special case.
func CountUserPrompts(conv *Conversation) int {
	if conv == nil {
		return 0
	}
	count := 0
	for _, entry := range getContextPathEntries(conv) {
		if entry.Type != EntryMessage {
			continue
		}
		md := asMessageData(entry.Data)
		if md == nil || md.Role != "user" {
			continue
		}
		if md.DisplayOnly {
			continue
		}
		blocks := contentToBlocks(md.Content)
		if isContextInjectionBlocks(blocks) {
			continue
		}
		hasText := false
		hasToolResult := false
		for _, b := range blocks {
			switch b.Type {
			case "text":
				if b.Text != "" {
					hasText = true
				}
			case "tool_result":
				hasToolResult = true
			}
		}
		if hasToolResult || !hasText {
			continue
		}
		count++
	}
	return count
}

// isContextInjectionBlocks reports whether a content-block slice is a
// read-triggered nested-context injection. Mirrors contextInjectionPaths'
// first-block check: every in-tree producer emits the injection as a
// single-block message whose first (only) block carries the
// context_injection discriminator.
func isContextInjectionBlocks(blocks []types.LlmContentBlock) bool {
	return len(blocks) > 0 && blocks[0].Type == ContextInjectionBlockType
}
