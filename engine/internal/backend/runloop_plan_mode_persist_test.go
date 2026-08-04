package backend

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// The EnterPlanMode tool result carries the full plan-mode framing, which is
// written in the present tense ("You are in planning mode. You MUST NOT make
// any edits ... This overrides any conflicting instructions you have received
// elsewhere in this prompt or conversation"). That text is correct for the
// turn it lands on and false on every turn after the mode is exited — but a
// tool result is persisted history, so the model re-read it as ground truth
// and refused to re-enter plan mode later in the same conversation, narrating
// the transition instead ("Next I enter planning mode and author the fix
// plan") because the tool's own description says "Do NOT call this tool if:
// You are already in plan mode."
//
// The fix splits what the provider sees this turn (Content) from what history
// keeps (PersistContent). These tests pin both halves independently:
//
//   - TestEnterPlanModeResultPersistsOnlyTheFact covers the call site: the
//     live result keeps the framing, the persisted one is the bare fact.
//   - TestAddToolResultsHonorsPersistContent covers the mechanism in the
//     conversation package.
//   - TestAddToolResultsWithoutPersistContentIsUnchanged proves the mechanism
//     was added rather than the persisted text simply being truncated for
//     every caller.

// TestEnterPlanModeResultPersistsOnlyTheFact pins the call site in
// interceptEnterPlanMode. Reverting the PersistContent assignment there makes
// the second assertion fail: the persisted text would carry the [PLAN MODE]
// framing again.
func TestEnterPlanModeResultPersistsOnlyTheFact(t *testing.T) {
	planFile := t.TempDir() + "/plan.md"
	run := &activeRun{requestID: "test-enter-persist"}
	results := make([]conversation.ToolResultEntry, 1)
	block := types.LlmContentBlock{
		Type: "tool_use",
		ID:   "tool-1",
		Name: tools.EnterPlanModeName,
	}
	// The plan file path is resolved by the OnPlanModeEnter hook, not read
	// from the run — interceptEnterPlanMode assigns run.planFilePath from
	// the hook's return value.
	hooks := RunHooks{
		OnPlanModeEnter: func() (bool, string, string) { return true, "", planFile },
	}

	handled := interceptEnterPlanMode(run, block, results, 0, hooks, func(*activeRun, types.NormalizedEvent) {})
	if !handled {
		t.Fatalf("interceptEnterPlanMode: want handled=true, got false")
	}

	got := results[0]

	// The model still receives the full framing on the turn it enters plan
	// mode — the fix must not have simply deleted the guidance.
	if !strings.Contains(got.Content, "[PLAN MODE]") {
		t.Errorf("live Content: want the [PLAN MODE] framing so the model knows the rules this turn, got %q", got.Content)
	}
	if !strings.Contains(got.Content, planFile) {
		t.Errorf("live Content: want the plan file path %q, got %q", planFile, got.Content)
	}

	// History keeps only the durable fact. The present-tense mode claim —
	// the part that expires — must not survive into the entry tree.
	if got.PersistContent == "" {
		t.Fatalf("PersistContent: want a persisted one-line fact, got empty (the full framing would be persisted verbatim)")
	}
	if strings.Contains(got.PersistContent, "[PLAN MODE]") {
		t.Errorf("PersistContent: must not carry the present-tense plan-mode framing, got %q", got.PersistContent)
	}
	if strings.Contains(got.PersistContent, "You are in planning mode") {
		t.Errorf("PersistContent: must not claim the session is in planning mode, got %q", got.PersistContent)
	}
	if strings.Contains(got.PersistContent, "overrides any conflicting instructions") {
		t.Errorf("PersistContent: must not out-rank later live instructions, got %q", got.PersistContent)
	}
	// The fact that IS durable: plan mode was entered, against this file.
	if !strings.Contains(got.PersistContent, planFile) {
		t.Errorf("PersistContent: want the plan file path %q so history stays useful, got %q", planFile, got.PersistContent)
	}
	if len(got.PersistContent) >= len(got.Content) {
		t.Errorf("PersistContent (%d chars) should be shorter than live Content (%d chars)", len(got.PersistContent), len(got.Content))
	}
}

// TestAddToolResultsHonorsPersistContent pins the conversation-package
// mechanism: the provider-visible message keeps Content, the entry tree gets
// PersistContent. Reverting the override loop in AddToolResults fails the
// entry assertion.
func TestAddToolResultsHonorsPersistContent(t *testing.T) {
	conv := conversation.CreateConversation("test-persist-tool-result", "", "test-model")
	conversation.AddUserMessage(conv, "Make a plan.")

	conversation.AddToolResults(conv, []conversation.ToolResultEntry{{
		ToolUseID:      "tool-1",
		Content:        "LIVE-TEXT-for-this-turn-only",
		PersistContent: "DURABLE-FACT",
	}})

	// Provider sees the live text on this turn.
	last := conv.Messages[len(conv.Messages)-1]
	if got := blockContent(t, last.Content, "tool-1"); got != "LIVE-TEXT-for-this-turn-only" {
		t.Errorf("conv.Messages: provider must see the live Content, got %q", got)
	}

	// History stores the durable fact instead.
	entry := conv.Entries[len(conv.Entries)-1]
	msg, ok := entry.Data.(conversation.MessageData)
	if !ok {
		t.Fatalf("last entry: want MessageData, got %T", entry.Data)
	}
	if got := blockContent(t, msg.Content, "tool-1"); got != "DURABLE-FACT" {
		t.Errorf("conv.Entries: history must store PersistContent, got %q", got)
	}
}

// TestAddToolResultsWithoutPersistContentIsUnchanged proves the override is
// opt-in. If this fails while the test above passes, the change over-reached
// and altered persistence for every tool result rather than adding a seam.
func TestAddToolResultsWithoutPersistContentIsUnchanged(t *testing.T) {
	conv := conversation.CreateConversation("test-persist-default", "", "test-model")
	conversation.AddUserMessage(conv, "Read a file.")

	conversation.AddToolResults(conv, []conversation.ToolResultEntry{{
		ToolUseID: "tool-1",
		Content:   "ordinary tool output",
	}})

	last := conv.Messages[len(conv.Messages)-1]
	if got := blockContent(t, last.Content, "tool-1"); got != "ordinary tool output" {
		t.Errorf("conv.Messages: want the unmodified content, got %q", got)
	}
	entry := conv.Entries[len(conv.Entries)-1]
	msg, ok := entry.Data.(conversation.MessageData)
	if !ok {
		t.Fatalf("last entry: want MessageData, got %T", entry.Data)
	}
	if got := blockContent(t, msg.Content, "tool-1"); got != "ordinary tool output" {
		t.Errorf("conv.Entries: a result with no PersistContent must persist Content verbatim, got %q", got)
	}
}

// blockContent returns the text of the tool_result block owned by toolUseID.
// msgContent is the LlmMessage/MessageData Content field, which is typed any
// and holds []types.LlmContentBlock for tool-result messages.
func blockContent(t *testing.T, msgContent any, toolUseID string) string {
	t.Helper()
	blocks, ok := msgContent.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("message content: want []types.LlmContentBlock, got %T", msgContent)
	}
	for _, b := range blocks {
		if b.Type == "tool_result" && b.ToolUseID == toolUseID {
			return b.Content
		}
	}
	t.Fatalf("tool_result block %s not found in %d blocks", toolUseID, len(blocks))
	return ""
}
