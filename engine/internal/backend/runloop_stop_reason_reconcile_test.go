package backend

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// These tests pin the stop-reason/payload reconciliation in
// dispatchStopReason. A provider may report a terminal stop reason on the
// same message that carries tool_use blocks — an OpenAI-compatible gateway
// emitting finish_reason "stop" after streaming tool-call deltas is the
// observed case. The block payload is authoritative in both directions.
//
// Regression origin: a run ended with an unexecuted Read call in hand,
// emitting TaskCompleteEvent and exit 0 while the model was still working.
// Reverting the guard in runloop_stop_reason.go must turn the first two
// tests below red.

// reconcileTestRun builds a run whose AgentStatus seam lets a tool_use block
// execute without spawning anything. AgentStatus is the cheapest real tool to
// drive through executeTools: it needs no filesystem, no network, and no
// permission prompt, so the test observes the routing decision rather than
// tool side effects.
func reconcileTestRun(requestID string) *activeRun {
	return &activeRun{
		requestID: requestID,
		cfg: &RunConfig{
			AgentStatus: func() []tools.AgentStatusEntry { return nil },
		},
	}
}

// reconcileToolBlock is a well-formed tool_use block for the AgentStatus tool.
func reconcileToolBlock(id string) types.LlmContentBlock {
	return types.LlmContentBlock{
		Type:  "tool_use",
		ID:    id,
		Name:  tools.AgentStatusToolName,
		Input: map[string]any{},
	}
}

// TestDispatchStopReasonEndTurnWithToolBlockKeepsLooping is the core
// regression test. A turn reporting end_turn while carrying a real tool_use
// block must execute the tool and keep looping (return false), never complete
// the run. On the unfixed code this returns true and the tool call is
// discarded.
func TestDispatchStopReasonEndTurnWithToolBlockKeepsLooping(t *testing.T) {
	b := NewApiBackend()
	run := reconcileTestRun("reconcile-end-turn")
	conv := &conversation.Conversation{ID: "reconcile-sess"}

	blocks := []types.LlmContentBlock{
		{Type: "text", Text: "Let me check the dispatch state."},
		reconcileToolBlock("reconcile-call-1"),
	}

	done := b.dispatchStopReason(
		context.Background(), run, conv, RunHooks{}, types.RunOptions{},
		effectiveEarlyStopConfig{}, blocks, "end_turn", 5, 1, 10, t.TempDir(),
	)

	if done {
		t.Fatal("dispatchStopReason returned true (run finished) for an end_turn turn carrying a tool_use block; the tool call was discarded and the run completed with work outstanding")
	}

	// The tool must actually have run: its result is persisted onto the
	// conversation before the loop continues. Asserting the routing decision
	// alone would pass even if the tool arm silently no-opped.
	if !convHasToolResult(conv, "reconcile-call-1") {
		t.Error("no tool_result persisted for the reconciled tool call; the tool_use arm did not execute it")
	}
}

// TestDispatchStopReasonStopWithToolBlockKeepsLooping pins the other spelling
// of the terminal reason. translateFinishReason maps OpenAI "stop" to
// "end_turn", but a provider can surface "stop" directly, and both are listed
// in the terminal case.
func TestDispatchStopReasonStopWithToolBlockKeepsLooping(t *testing.T) {
	b := NewApiBackend()
	run := reconcileTestRun("reconcile-stop")
	conv := &conversation.Conversation{ID: "reconcile-sess"}

	blocks := []types.LlmContentBlock{reconcileToolBlock("reconcile-call-2")}

	done := b.dispatchStopReason(
		context.Background(), run, conv, RunHooks{}, types.RunOptions{},
		effectiveEarlyStopConfig{}, blocks, "stop", 5, 1, 10, t.TempDir(),
	)

	if done {
		t.Fatal("dispatchStopReason returned true for a \"stop\" turn carrying a tool_use block; both terminal spellings must reconcile")
	}
}

// TestDispatchStopReasonEndTurnWithoutToolBlockCompletes pins that the
// ordinary completion path is untouched. A genuine end_turn with no tool call
// must still finish the run — the guard must not turn every end_turn into
// another loop iteration.
func TestDispatchStopReasonEndTurnWithoutToolBlockCompletes(t *testing.T) {
	b := NewApiBackend()
	run := reconcileTestRun("reconcile-plain-end-turn")
	conv := &conversation.Conversation{ID: "reconcile-sess"}

	blocks := []types.LlmContentBlock{
		{Type: "text", Text: "All done."},
	}

	done := b.dispatchStopReason(
		context.Background(), run, conv, RunHooks{}, types.RunOptions{},
		effectiveEarlyStopConfig{}, blocks, "end_turn", 5, 1, 10, t.TempDir(),
	)

	if !done {
		t.Fatal("dispatchStopReason returned false for a plain end_turn with no tool blocks; the normal completion path regressed")
	}
}

// TestDispatchStopReasonToolUseWithZeroBlocksKeepsLooping pins the complement
// guard that already existed: a tool_use stop reason with no tool blocks is
// treated as end_turn and keeps looping. The two guards cover opposite skews
// and neither may be collapsed into the other.
func TestDispatchStopReasonToolUseWithZeroBlocksKeepsLooping(t *testing.T) {
	b := NewApiBackend()
	run := reconcileTestRun("reconcile-inverse")
	conv := &conversation.Conversation{ID: "reconcile-sess"}

	blocks := []types.LlmContentBlock{
		{Type: "text", Text: "no tool call despite the reason"},
	}

	done := b.dispatchStopReason(
		context.Background(), run, conv, RunHooks{}, types.RunOptions{},
		effectiveEarlyStopConfig{}, blocks, "tool_use", 5, 1, 10, t.TempDir(),
	)

	if done {
		t.Fatal("dispatchStopReason returned true for a tool_use reason with zero tool blocks; the pre-existing inverse-skew guard regressed")
	}
}

// convHasToolResult reports whether the conversation carries a tool_result for
// the given tool_use id. Reads the flattened message view so it does not
// depend on tree-entry internals.
func convHasToolResult(conv *conversation.Conversation, toolUseID string) bool {
	for _, msg := range conv.Messages {
		blocks, ok := msg.Content.([]types.LlmContentBlock)
		if !ok {
			continue
		}
		for _, block := range blocks {
			if block.Type == "tool_result" && block.ToolUseID == toolUseID {
				return true
			}
		}
	}
	return false
}
