package conversation

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestLegacyRecoveryRepair_RestoresVerifiedAttachmentAndClassifiesRevival(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	bytes := []byte("recovery attachment")
	digest := sha256.Sum256(bytes)
	name := hex.EncodeToString(digest[:]) + ".png"
	imageDir := filepath.Join(home, ".ion", "user-images")
	if err := os.MkdirAll(imageDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(imageDir, name), bytes, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	conv := CreateConversation("legacy-recovery-repair", "", "test-model")
	AppendEntry(conv, EntryMessage, MessageData{
		Role:    "user",
		Content: "[map[text:[Attachment: " + name + " (content attached)]\n\ninspect type:text]]",
	})
	AppendEntry(conv, EntryMessage, MessageData{
		Role:    "user",
		Content: legacyParkedReviveOne + "\n--- [child] completed (dispatch d-1) ---\ndone\n",
	})
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	rows, err := LoadMessages(conv.ID, "")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	if rows[0].Content != "[Attachment: "+name+" (content attached)]\n\ninspect" {
		t.Fatalf("repaired content = %q", rows[0].Content)
	}
	if len(rows[0].Attachments) != 1 || rows[0].Attachments[0].Path == "" {
		t.Fatalf("repaired attachments = %#v", rows[0].Attachments)
	}
	if rows[1].InjectionKind != string(types.InjectionKindAgentCompletion) || !rows[1].MachineAuthored {
		t.Fatalf("revival classification = %#v", rows[1])
	}

	loaded, err := Load(conv.ID, "")
	if err != nil {
		t.Fatalf("Load after repair: %v", err)
	}
	if err := Save(loaded, ""); err != nil {
		t.Fatalf("Save repaired conversation: %v", err)
	}
	reloadedRows, err := LoadMessages(conv.ID, "")
	if err != nil {
		t.Fatalf("LoadMessages after rewrite: %v", err)
	}
	if len(reloadedRows) != 2 || len(reloadedRows[0].Attachments) != 1 || !reloadedRows[1].MachineAuthored {
		t.Fatalf("rewritten rows = %#v", reloadedRows)
	}
}

func TestLegacyRecoveryRepair_ClassifiesLegacyRootDispatchCompletion(t *testing.T) {
	conv := CreateConversation("legacy-root-dispatch", "", "test-model")
	AppendEntry(conv, EntryMessage, MessageData{
		Role:    "user",
		Content: "[Agent worker completed]\nDispatch ID: dispatch-worker-123\nElapsed: 60.5s\n\nfull child output",
	})
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	rows, err := LoadMessages(conv.ID, "")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	if len(rows) != 1 || rows[0].InjectionKind != string(types.InjectionKindAgentCompletion) || !rows[0].MachineAuthored {
		t.Fatalf("legacy completion classification = %#v", rows)
	}

	loaded, err := Load(conv.ID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	entry := asMessageData(loaded.Entries[0].Data)
	if entry == nil || entry.InjectionKind != string(types.InjectionKindAgentCompletion) || !entry.MachineAuthored {
		t.Fatalf("repaired entry = %#v", entry)
	}
	if err := Save(loaded, ""); err != nil {
		t.Fatalf("Save repaired: %v", err)
	}
	reloaded, err := LoadMessages(conv.ID, "")
	if err != nil || len(reloaded) != 1 || !reloaded[0].MachineAuthored {
		t.Fatalf("reloaded completion = %#v, err=%v", reloaded, err)
	}
}

func TestLegacyRecoveryRepair_DoesNotClassifyUserDispatchProse(t *testing.T) {
	conv := CreateConversation("legacy-dispatch-prose", "", "test-model")
	AppendEntry(conv, EntryMessage, MessageData{
		Role:    "user",
		Content: "[Agent worker completed]\nDispatch ID: not-a-dispatch\nElapsed: 60.5s\n\nuser-authored note",
	})
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	rows, err := LoadMessages(conv.ID, "")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	if len(rows) != 1 || rows[0].InjectionKind != "" || rows[0].MachineAuthored {
		t.Fatalf("user dispatch prose was classified = %#v", rows)
	}
}
func TestLegacyRecoveryRepair_ClassifiesDispatchRowCarryingTrailingBlock(t *testing.T) {
	// The wedge: a dispatch delivery whose row also carries a structural block
	// (skill_listing here). The classifier used to require a SINGLETON text
	// block, so every such row stayed unclassified and rendered as if the
	// operator had typed it. Reverting legacyRecoveryMessageText to the
	// len(blocks)==1 gate fails this test.
	conv := CreateConversation("legacy-dispatch-trailing-block", "", "test-model")
	AddUserMessage(conv, []types.LlmContentBlock{
		{Type: "text", Text: "[Agent agent-1 completed]\nDispatch ID: dispatch-agent-1-1786802502205-09f47a5f40da\nElapsed: 220.5s\n\nchild output"},
		{Type: "skill_listing", Text: "# Available Skills"},
	})
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	rows, err := LoadMessages(conv.ID, "")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	if len(rows) != 1 || rows[0].InjectionKind != string(types.InjectionKindAgentCompletion) || !rows[0].MachineAuthored {
		t.Fatalf("multi-block dispatch classification = %#v", rows)
	}

	// The trailing structural block must survive classification untouched.
	loaded, err := Load(conv.ID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	blocks := contentToBlocks(asMessageData(loaded.Entries[0].Data).Content)
	if len(blocks) != 2 || blocks[1].Type != "skill_listing" {
		t.Fatalf("blocks after classification = %#v", blocks)
	}
}

func TestLegacyRecoveryRepair_PreservesSkillListingAlongsideRepairedText(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	bytes := []byte("mixed recovery attachment")
	digest := sha256.Sum256(bytes)
	name := hex.EncodeToString(digest[:]) + ".png"
	imageDir := filepath.Join(home, ".ion", "user-images")
	if err := os.MkdirAll(imageDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(imageDir, name), bytes, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	conv := CreateConversation("legacy-recovery-skill-listing", "", "test-model")
	AddUserMessage(conv, []types.LlmContentBlock{
		{Type: "text", Text: "[map[text:[Attachment: " + name + " (content attached)]\n\ninspect type:text]]"},
		{Type: "skill_listing", Text: "# Available Skills"},
	})
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	rows, err := LoadMessages(conv.ID, "")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	if len(rows) != 1 || rows[0].Content != "[Attachment: "+name+" (content attached)]\n\ninspect" || len(rows[0].Attachments) != 1 {
		t.Fatalf("repaired mixed row = %#v", rows)
	}

	loaded, err := Load(conv.ID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	blocks := contentToBlocks(asMessageData(loaded.Entries[0].Data).Content)
	if len(blocks) != 3 || blocks[1].Type != "image" || blocks[2].Type != "skill_listing" || blocks[2].Text != "# Available Skills" {
		t.Fatalf("repaired mixed blocks = %#v", blocks)
	}
	if err := Save(loaded, ""); err != nil {
		t.Fatalf("Save repaired: %v", err)
	}
	reloaded, err := LoadMessages(conv.ID, "")
	if err != nil || len(reloaded) != 1 || len(reloaded[0].Attachments) != 1 {
		t.Fatalf("reloaded mixed row = %#v, err=%v", reloaded, err)
	}
}
func TestLegacyRecoveryRepair_LeavesUnverifiedAndOrdinaryContentUntouched(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	missing := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"
	broken := "[map[text:[Attachment: " + missing + " (content attached)]\n\ninspect type:text]]"
	conv := CreateConversation("legacy-recovery-missing", "", "test-model")
	AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: broken})
	AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: "[SYSTEM] ordinary prose from a user"})
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	rows, err := LoadMessages(conv.ID, "")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	if rows[0].Content != "[Attachment: "+missing+" (content attached)]\n\ninspect" || len(rows[0].Attachments) != 0 {
		t.Fatalf("unverified repair = %#v", rows[0])
	}
	if rows[1].InjectionKind != "" || rows[1].MachineAuthored {
		t.Fatalf("ordinary text was classified: %#v", rows[1])
	}
}

func TestToContentBlocks_DecodesJSONRecoveredBlockSlices(t *testing.T) {
	blocks := toContentBlocks([]any{map[string]any{"type": "text", "text": "recover"}})
	if len(blocks) != 1 || blocks[0].Type != "text" || blocks[0].Text != "recover" {
		t.Fatalf("decoded blocks = %#v", blocks)
	}
}
