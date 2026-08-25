package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestAddUserMessageWithInvocation pins the slash-command display split
// (plan verification point 2): the LLM-visible message (conv.Messages) holds the
// EXPANDED body, while the persisted tree entry holds the RAW invocation plus
// provenance, and flattenEntries surfaces the raw invocation + provenance on the
// SessionMessage so a reloaded conversation re-renders the command pill.
func TestAddUserMessageWithInvocation(t *testing.T) {
	conv := CreateConversation("test-conv", "", "test-model")

	AddUserMessageWithInvocation(conv, "EXPANDED TEMPLATE BODY for the model", SlashInvocation{
		Command: "/diagram",
		Args:    "make a flowchart",
		Source:  "ion",
		Frontmatter: map[string]any{
			"description":      "diagram a system",
			"allowed-tools":    []string{"Read", "Grep"},
			"extension-policy": "reviewed",
		},
	})

	// LLM sees the expanded body.
	if len(conv.Messages) != 1 {
		t.Fatalf("expected 1 LLM message, got %d", len(conv.Messages))
	}
	llm := conv.Messages[0]
	if llm.Role != "user" {
		t.Errorf("llm role = %q", llm.Role)
	}
	blocks, ok := llm.Content.([]types.LlmContentBlock)
	if !ok || len(blocks) != 1 || blocks[0].Text != "EXPANDED TEMPLATE BODY for the model" {
		t.Errorf("llm content = %#v, want expanded body", llm.Content)
	}

	// The display entry holds the raw invocation + provenance.
	if len(conv.Entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(conv.Entries))
	}
	md := asMessageData(conv.Entries[0].Data)
	if md == nil {
		t.Fatal("entry data is not MessageData")
	}
	if md.SlashCommand != "/diagram" || md.SlashArgs != "make a flowchart" || md.SlashSource != "ion" {
		t.Errorf("provenance = (%q,%q,%q)", md.SlashCommand, md.SlashArgs, md.SlashSource)
	}
	if got := md.SlashFrontmatter["extension-policy"]; got != "reviewed" {
		t.Errorf("persisted extension frontmatter = %v, want reviewed", got)
	}
	dispBlocks := contentToBlocks(md.Content)
	if len(dispBlocks) != 1 || dispBlocks[0].Text != "/diagram make a flowchart" {
		t.Errorf("display content = %#v, want raw invocation", md.Content)
	}

	// flattenEntries surfaces the raw invocation + provenance (reload path).
	msgs := flattenEntries(conv)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 flattened message, got %d", len(msgs))
	}
	sm := msgs[0]
	if sm.Content != "/diagram make a flowchart" {
		t.Errorf("flattened content = %q, want raw invocation", sm.Content)
	}
	if sm.SlashCommand != "/diagram" || sm.SlashArgs != "make a flowchart" || sm.SlashSource != "ion" {
		t.Errorf("flattened provenance = (%q,%q,%q)", sm.SlashCommand, sm.SlashArgs, sm.SlashSource)
	}
	if got := sm.SlashFrontmatter["extension-policy"]; got != "reviewed" {
		t.Errorf("flattened extension frontmatter = %v, want reviewed", got)
	}
}

// TestSlashFrontmatterDurableRoundTrip pins slash frontmatter in the tree
// sidecar and the reload surface, including keys engine itself does not use.
func TestSlashFrontmatterDurableRoundTrip(t *testing.T) {
	conv := CreateConversation("slash-frontmatter-roundtrip", "", "test-model")
	AddUserMessageWithInvocation(conv, "expanded", SlashInvocation{
		Command: "/review",
		Source:  "ion",
		Frontmatter: map[string]any{
			"custom-key": "durable",
			"tools":      []string{"Read", "Grep"},
		},
	})

	dir := t.TempDir()
	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	reloaded, err := Load(conv.ID, dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	msgs := flattenEntries(reloaded)
	if len(msgs) != 1 {
		t.Fatalf("flattened messages = %d, want 1", len(msgs))
	}
	if got := msgs[0].SlashFrontmatter["custom-key"]; got != "durable" {
		t.Errorf("reloaded custom frontmatter = %v, want durable", got)
	}
	tools, ok := msgs[0].SlashFrontmatter["tools"].([]interface{})
	if !ok || len(tools) != 2 || tools[0] != "Read" || tools[1] != "Grep" {
		t.Errorf("reloaded tools = %#v, want [Read Grep]", msgs[0].SlashFrontmatter["tools"])
	}
}

// TestAddUserMessageWithInvocation_NoArgs pins that a no-arg invocation persists
// just the command with no trailing space.
func TestAddUserMessageWithInvocation_NoArgs(t *testing.T) {
	conv := CreateConversation("c", "", "m")
	AddUserMessageWithInvocation(conv, "expanded", SlashInvocation{Command: "/clear", Source: "ion"})
	msgs := flattenEntries(conv)
	if len(msgs) != 1 || msgs[0].Content != "/clear" {
		t.Errorf("flattened = %#v, want content=/clear", msgs)
	}
}

// TestAddUserMessage_NoProvenance confirms the ordinary path leaves the slash
// provenance fields empty (so a normal message never renders as a pill).
func TestAddUserMessage_NoProvenance(t *testing.T) {
	conv := CreateConversation("c", "", "m")
	AddUserMessage(conv, "just a normal message")
	msgs := flattenEntries(conv)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].SlashCommand != "" || msgs[0].SlashArgs != "" || msgs[0].SlashSource != "" {
		t.Errorf("ordinary message carried slash provenance: %#v", msgs[0])
	}
}

// TestDisplayOnlyEntryExcludedFromContextPath pins the DisplayOnly contract: an
// entry flagged DisplayOnly appears in the tree (scrollback, flattenEntries) but
// is excluded from BuildContextPath, so a rebuilt .llm.jsonl never resurrects a
// turn the model did not see. This is the mechanism the `context: fork` slash
// path relies on to record the raw invocation for the user without poisoning the
// parent's LLM context. Reverting the BuildContextPath skip makes this fail.
func TestDisplayOnlyEntryExcludedFromContextPath(t *testing.T) {
	conv := CreateConversation("display-only-conv", "system", "test-model")

	// A normal prior LLM turn.
	AddUserMessage(conv, "real turn the model saw")

	// A display-only fork invocation entry (tree-visible, not LLM-visible).
	AppendEntry(conv, EntryMessage, MessageData{
		Role:         "user",
		Content:      []types.LlmContentBlock{textBlock("/heavy the payload")},
		SlashCommand: "/heavy",
		SlashArgs:    "the payload",
		SlashSource:  "ion",
		DisplayOnly:  true,
	})

	// BuildContextPath (what saveSplit writes to .llm.jsonl) must include the
	// real turn but NOT the display-only invocation.
	ctx := BuildContextPath(conv)
	if len(ctx) != 1 {
		t.Fatalf("expected 1 LLM message (display-only excluded), got %d: %+v", len(ctx), ctx)
	}
	gotBlocks, _ := ctx[0].Content.([]types.LlmContentBlock)
	if len(gotBlocks) != 1 || gotBlocks[0].Text != "real turn the model saw" {
		t.Errorf("context path message = %#v, want the real turn only", ctx[0].Content)
	}

	// The display-only entry still surfaces in the tree/scrollback view.
	msgs := flattenEntries(conv)
	var sawInvocation bool
	for _, m := range msgs {
		if m.SlashCommand == "/heavy" {
			sawInvocation = true
		}
	}
	if !sawInvocation {
		t.Error("display-only fork invocation should still appear in flattenEntries (scrollback)")
	}
}
