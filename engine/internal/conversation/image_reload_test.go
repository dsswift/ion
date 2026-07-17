package conversation

// image_reload_test.go pins the contract that engine-generated tool-result
// images survive a Save → Load round-trip and are replayed by flattenEntries as
// a SessionMessage.Attachments entry on the owning tool-call row.
//
// Why it matters: during a live run the engine saves each tool-returned image
// to the conversation's images/ directory and emits an ImageContentEvent per
// image; clients attach it to the owning tool message. That event is NOT
// persisted. Before this work, flattenEntries handled only "text" and
// "tool_result" blocks and dropped every "image" block, so an image vanished on
// historical reload — the live path worked, the reload path lost the image on
// both clients. These tests exercise the same LoadMessages path external
// callers use (Save → Load from disk → flattenEntries), including the JSON
// round-trip where the persisted image block comes back as map[string]any.

import (
	"encoding/base64"
	"os"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// tinyPNG is a minimal valid-enough PNG byte sequence for the saver (the saver
// does not validate image structure; it writes bytes and content-addresses the
// name).
var tinyPNG = []byte{
	0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
	0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
}

// TestToolResultImage_ReplayedOnLoad asserts that a tool-result image persisted
// alongside its tool call is replayed as a SessionMessage.Attachments entry on
// the tool-call row after a full Save → Load round-trip.
//
// This test is RED without the "image" case in flattenEntries (the image block
// is dropped and the tool row has no attachment) AND without the ToolUseID
// carried on the persisted image block in AddToolResults (the reloaded image
// has no owning tool call and is dropped as an orphan). Revert either and the
// "expected one attachment" assertion fails.
func TestToolResultImage_ReplayedOnLoad(t *testing.T) {
	dir := t.TempDir()
	b64 := base64.StdEncoding.EncodeToString(tinyPNG)

	conv := CreateConversation("tool-image-reload", "be helpful", "claude-3-5-sonnet")
	AddUserMessage(conv, "take a screenshot")
	// Assistant makes a tool call whose id owns the returned image.
	AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "text", Text: "Taking a screenshot."},
		{Type: "tool_use", ID: "tu_shot", Name: "Screenshot", Input: map[string]any{}},
	}, types.LlmUsage{InputTokens: 10, OutputTokens: 15})
	// Tool returns text + one vision image, exactly as the runloop persists it.
	AddToolResults(conv, []ToolResultEntry{
		{
			ToolUseID: "tu_shot",
			Content:   "[Image: screenshot]",
			Images:    []*types.ImageSource{{Type: "base64", MediaType: "image/png", Data: b64}},
		},
	})

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	msgs, err := LoadMessages(conv.ID, dir)
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}

	// Find the tool-call row (Role=="tool", ToolID=="tu_shot").
	var toolRow *types.SessionMessage
	for i := range msgs {
		if msgs[i].Role == "tool" && msgs[i].ToolID == "tu_shot" {
			toolRow = &msgs[i]
			break
		}
	}
	if toolRow == nil {
		t.Fatal("expected a tool-call row for tu_shot after reload, found none")
	}
	if len(toolRow.Attachments) != 1 {
		t.Fatalf("tool row Attachments len = %d, want 1 (image dropped on reload)", len(toolRow.Attachments))
	}
	att := toolRow.Attachments[0]
	if att.Type != "image" {
		t.Errorf("attachment Type = %q, want \"image\"", att.Type)
	}
	if att.MediaType != "image/png" {
		t.Errorf("attachment MediaType = %q, want \"image/png\"", att.MediaType)
	}
	if att.Path == "" {
		t.Error("attachment Path is empty, want an on-disk file path")
	}
	if att.Path == b64 {
		t.Error("attachment Path is the base64 payload; want a FILE PATH (never base64 on the wire)")
	}
	// The re-derived file must actually exist on disk (the reload saver either
	// found the live-written file or recreated it content-addressed).
	if _, statErr := os.Stat(att.Path); statErr != nil {
		t.Errorf("attachment Path does not exist on disk: %v", statErr)
	}
	// The tool row's content still carries the result text.
	if toolRow.Content != "[Image: screenshot]" {
		t.Errorf("tool row Content = %q, want \"[Image: screenshot]\"", toolRow.Content)
	}
}

// TestToolResultImage_ContentAddressedDedup asserts the reload save resolves to
// the same on-disk file the live save wrote (content-addressed), rather than a
// second duplicate file. This pins the idempotency the reload path relies on:
// SaveImageToConversation is called both at emit time (live) and again at
// reload time from the persisted base64 block, and both must land on one file.
func TestToolResultImage_ContentAddressedDedup(t *testing.T) {
	dir := t.TempDir()
	b64 := base64.StdEncoding.EncodeToString(tinyPNG)

	// Simulate the live emit-time save.
	livePath, err := SaveImageToConversation(dir, "dedup-conv", "image/png", b64)
	if err != nil {
		t.Fatalf("live SaveImageToConversation: %v", err)
	}
	// Simulate the reload-time save of the same bytes.
	reloadPath, err := SaveImageToConversation(dir, "dedup-conv", "image/png", b64)
	if err != nil {
		t.Fatalf("reload SaveImageToConversation: %v", err)
	}
	if livePath != reloadPath {
		t.Errorf("content-addressed save produced two paths:\n live=%q\n reload=%q", livePath, reloadPath)
	}
}

// TestFlattenEntries_LegacyOrphanImages pins the pre-fix reload path (issue
// #224): conversations persisted before the ToolUseID stamping was added
// (commit b9f399e2) carry "image" blocks with an EMPTY ToolUseID. The
// toolCallIndex lookup can never match an empty key, so before this fix those
// images were silently dropped and the user saw no images on reload. The fix
// attaches each empty-ToolUseID image to the most recent tool-call row, using
// the persisted block order [tool_result, tool_result, image, image].
//
// This test is RED without the empty-ToolUseID fallback in flattenEntries: the
// tool row has zero attachments and the assertions below fail.
func TestFlattenEntries_LegacyOrphanImages(t *testing.T) {
	b64 := base64.StdEncoding.EncodeToString(tinyPNG)

	conv := CreateConversation("1783802415913-legacy", "be helpful", "claude-3-5-sonnet")
	AddUserMessage(conv, "take two screenshots")
	// Assistant makes two tool calls.
	AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "tool_use", ID: "tu_a", Name: "Screenshot", Input: map[string]any{}},
		{Type: "tool_use", ID: "tu_b", Name: "Screenshot", Input: map[string]any{}},
	}, types.LlmUsage{InputTokens: 10, OutputTokens: 15})

	// Pre-fix persisted user turn: tool_result blocks carry their ToolUseID
	// (results were always associated), but the image blocks were persisted
	// with an EMPTY ToolUseID because the stamping did not exist yet. Block
	// order is [tool_result, tool_result, image, image].
	AppendEntry(conv, EntryMessage, MessageData{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "tu_a", Content: "[Image: shot A]"},
			{Type: "tool_result", ToolUseID: "tu_b", Content: "[Image: shot B]"},
			{Type: "image", Source: &types.ImageSource{Type: "base64", MediaType: "image/png", Data: b64}},
			{Type: "image", Source: &types.ImageSource{Type: "base64", MediaType: "image/png", Data: b64}},
		},
	})

	msgs := flattenEntries(conv)

	// Find the two tool-call rows.
	var rowA, rowB *types.SessionMessage
	for i := range msgs {
		switch msgs[i].ToolID {
		case "tu_a":
			rowA = &msgs[i]
		case "tu_b":
			rowB = &msgs[i]
		}
	}
	if rowA == nil || rowB == nil {
		t.Fatalf("expected tool rows tu_a and tu_b, got A=%v B=%v", rowA, rowB)
	}

	// Both empty-ToolUseID images attach to the most recent tool-call row
	// (tu_b), which is the last "tool" role entry in result at attach time.
	if len(rowB.Attachments) != 2 {
		t.Fatalf("tu_b Attachments len = %d, want 2 (legacy orphan images dropped)", len(rowB.Attachments))
	}
	if len(rowA.Attachments) != 0 {
		t.Errorf("tu_a Attachments len = %d, want 0 (images attach to the last tool row)", len(rowA.Attachments))
	}
	for i, att := range rowB.Attachments {
		if att.Type != "image" {
			t.Errorf("attachment[%d] Type = %q, want \"image\"", i, att.Type)
		}
		if att.Path == "" || att.Path == b64 {
			t.Errorf("attachment[%d] Path = %q, want an on-disk file path (never base64)", i, att.Path)
		}
	}
}

// TestUserPromptImage_ReplayedOnUserRow asserts that an image the CLIENT sent
// as a prompt attachment (RunOptions.Attachments → buildUserContentBlocks →
// a user entry with [text, image] blocks and NO tool_result blocks) reloads
// with the attachment on the USER row itself.
//
// This test is RED without the tool-result-carrier discriminator in
// flattenEntries: the prompt image has an empty ToolUseID, so it fell into
// the legacy last-tool-row heuristic and — with no tool row in the
// conversation (first message) — was silently dropped. The user row carried
// no Attachments and the image vanished from every history load.
func TestUserPromptImage_ReplayedOnUserRow(t *testing.T) {
	dir := t.TempDir()
	b64 := base64.StdEncoding.EncodeToString(tinyPNG)

	conv := CreateConversation("prompt-image-reload", "be helpful", "claude-3-5-sonnet")
	// Exactly the shape buildUserContentBlocks writes for a prompt with one
	// image attachment: text block first, image block after, no tool_result.
	AddUserMessage(conv, []types.LlmContentBlock{
		{Type: "text", Text: "[Attachment: photo.jpeg (content attached)]\n\nwhat is this image?"},
		{Type: "image", Source: &types.ImageSource{Type: "base64", MediaType: "image/png", Data: b64}},
	})

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	msgs, err := LoadMessages(conv.ID, dir)
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}

	var userRow *types.SessionMessage
	for i := range msgs {
		if msgs[i].Role == "user" {
			userRow = &msgs[i]
			break
		}
	}
	if userRow == nil {
		t.Fatal("expected a user row after reload, found none")
	}
	if len(userRow.Attachments) != 1 {
		t.Fatalf("user row Attachments len = %d, want 1 (prompt image dropped on reload)", len(userRow.Attachments))
	}
	att := userRow.Attachments[0]
	if att.Type != "image" {
		t.Errorf("attachment Type = %q, want \"image\"", att.Type)
	}
	if att.MediaType != "image/png" {
		t.Errorf("attachment MediaType = %q, want \"image/png\"", att.MediaType)
	}
	if att.Path == "" || att.Path == b64 {
		t.Errorf("attachment Path = %q, want an on-disk file path (never base64)", att.Path)
	}
	if _, statErr := os.Stat(att.Path); statErr != nil {
		t.Errorf("attachment Path does not exist on disk: %v", statErr)
	}
	// No tool row exists, and the image must NOT have been misattached
	// anywhere else or dropped.
	for i := range msgs {
		if msgs[i].Role == "tool" && len(msgs[i].Attachments) > 0 {
			t.Errorf("tool row %d carries %d attachments; prompt image misattached", i, len(msgs[i].Attachments))
		}
	}
}

// TestUserPromptImage_NotMisattachedToPriorToolRow pins the misattribution
// half of the defect: a prompt image sent in a LATER turn of a conversation
// that already has tool rows must attach to its own user row, not to the
// most recent tool-call row via the legacy empty-ToolUseID heuristic.
func TestUserPromptImage_NotMisattachedToPriorToolRow(t *testing.T) {
	dir := t.TempDir()
	b64 := base64.StdEncoding.EncodeToString(tinyPNG)

	conv := CreateConversation("prompt-image-later-turn", "be helpful", "claude-3-5-sonnet")
	AddUserMessage(conv, "run a tool")
	AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "tool_use", ID: "tu_prior", Name: "Bash", Input: map[string]any{}},
	}, types.LlmUsage{InputTokens: 5, OutputTokens: 5})
	AddToolResults(conv, []ToolResultEntry{
		{ToolUseID: "tu_prior", Content: "done"},
	})
	// Next turn: user sends an image prompt.
	AddUserMessage(conv, []types.LlmContentBlock{
		{Type: "text", Text: "now look at this"},
		{Type: "image", Source: &types.ImageSource{Type: "base64", MediaType: "image/png", Data: b64}},
	})

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	msgs, err := LoadMessages(conv.ID, dir)
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}

	var promptRow, toolRow *types.SessionMessage
	for i := range msgs {
		if msgs[i].Role == "user" && msgs[i].Content == "now look at this" {
			promptRow = &msgs[i]
		}
		if msgs[i].Role == "tool" && msgs[i].ToolID == "tu_prior" {
			toolRow = &msgs[i]
		}
	}
	if promptRow == nil {
		t.Fatal("expected the image-prompt user row after reload, found none")
	}
	if toolRow == nil {
		t.Fatal("expected the prior tool row after reload, found none")
	}
	if len(promptRow.Attachments) != 1 {
		t.Fatalf("prompt user row Attachments len = %d, want 1", len(promptRow.Attachments))
	}
	if len(toolRow.Attachments) != 0 {
		t.Errorf("prior tool row Attachments len = %d, want 0 (prompt image misattached to tool row)", len(toolRow.Attachments))
	}
}

// TestUserPromptDocument_TypedAsFile asserts a non-image prompt attachment
// (e.g. a PDF document block) reloads as Type "file" so clients don't try to
// render it as an image; name and path still flow for display.
func TestUserPromptDocument_TypedAsFile(t *testing.T) {
	dir := t.TempDir()
	b64 := base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 tiny"))

	conv := CreateConversation("prompt-pdf-reload", "be helpful", "claude-3-5-sonnet")
	AddUserMessage(conv, []types.LlmContentBlock{
		{Type: "text", Text: "summarize this"},
		{Type: "image", Source: &types.ImageSource{Type: "base64", MediaType: "application/pdf", Data: b64}},
	})

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	msgs, err := LoadMessages(conv.ID, dir)
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}

	var userRow *types.SessionMessage
	for i := range msgs {
		if msgs[i].Role == "user" {
			userRow = &msgs[i]
			break
		}
	}
	if userRow == nil {
		t.Fatal("expected a user row after reload, found none")
	}
	if len(userRow.Attachments) != 1 {
		t.Fatalf("user row Attachments len = %d, want 1", len(userRow.Attachments))
	}
	if userRow.Attachments[0].Type != "file" {
		t.Errorf("attachment Type = %q, want \"file\" for non-image media", userRow.Attachments[0].Type)
	}
	if userRow.Attachments[0].Path == "" {
		t.Error("attachment Path is empty, want an on-disk file path")
	}
}
