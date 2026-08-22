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

// TestLegacyRecoveryRepair_ClassifiesHistoricalMachineShapes covers the rows
// that were still visible in real transcripts after the append fix landed.
//
// The append fix stops NEW rows from persisting unclassified. It does nothing
// for the rows already on disk, and the repair sweep only recognised one
// dispatch-completion shape: the engine's own "[Agent X completed]\nDispatch
// ID: ...\nElapsed: Ns" envelope. Every other machine-authored shape an
// operator's history actually contains went unmatched, so the sweep ran,
// classified nothing, and the rows kept rendering as user turns.
//
// The shapes below are taken from a survey of real conversation files, not
// invented. Each has exactly one producer:
//
//   - "[Agent X <verb>]" with the harness verb set — the dispatch-result
//     envelope written by ctx.sendMessage before the harness carried a kind.
//   - "[SYSTEM] Plan mode still active" — the engine's plan-mode reminder,
//     which is transient today (runloop_inject.go) but was persisted before.
//   - "[SYSTEM] Dispatch check-in" — the harness idle heartbeat.
//
// Revert-red: drop any arm from legacyMachineSignature and its case here
// fails, because the row reloads unclassified and therefore visible.
func TestLegacyRecoveryRepair_ClassifiesHistoricalMachineShapes(t *testing.T) {
	cases := []struct {
		name string
		text string
		want types.InjectionKind
	}{{
		name: "dispatch completed with elapsed",
		text: "[Agent Dev Lead completed in 472s]\n\nBoth commits are in.",
		want: types.InjectionKindAgentCompletion,
	}, {
		name: "dispatch completed bare with engine envelope",
		text: "[Agent agent-1 completed]\nDispatch ID: dispatch-agent-1-178\nElapsed: 5s\n\nresult body",
		want: types.InjectionKindAgentCompletion,
	}, {
		name: "dispatch failed with reason",
		text: "[Agent Chief Of Product failed]: dispatch not available",
		want: types.InjectionKindAgentCompletion,
	}, {
		name: "dispatch recalled with reason token",
		text: "[Agent Dev Lead recalled after 133s] recall_agent",
		want: types.InjectionKindAgentCompletion,
	}, {
		name: "dispatch timed out",
		text: "[Agent Dev Lead timed out after 900s] Dispatch timed out",
		want: types.InjectionKindAgentCompletion,
	}, {
		name: "dispatch produced a plan",
		text: "[Agent Dev Lead produced a plan in 88s]\nPlan file: /tmp/p.md",
		want: types.InjectionKindAgentCompletion,
	}, {
		name: "dispatch produced no output",
		text: "[Agent Qa Lead produced no output after 12s]",
		want: types.InjectionKindAgentCompletion,
	}, {
		name: "dispatch lost to engine restart",
		text: "[Agent comms-director was LOST — the engine restarted while it was running]\nDispatch d-1 never completed.",
		want: types.InjectionKindRevive,
	}, {
		name: "child question bubbled to parent",
		text: "[Agent Dev Lead is waiting for your answer]\nAgent \"dev-lead\" asked: which branch?",
		want: types.InjectionKindRevive,
	}, {
		name: "plan mode reminder",
		text: "[SYSTEM] Plan mode still active (see full instructions from earlier in conversation). Read-only except plan file.",
		want: types.InjectionKindSystemSteer,
	}, {
		name: "dispatch check-in heartbeat",
		text: "[SYSTEM] Dispatch check-in\n\nYou have been idle for ~10 minutes with 2 background dispatches still running.",
		want: types.InjectionKindCheckIn,
	}}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			conv := CreateConversation("legacy-shape-"+tc.name, "", "test-model")
			AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: tc.text})
			if err := Save(conv, ""); err != nil {
				t.Fatalf("Save: %v", err)
			}

			rows, err := LoadMessages(conv.ID, "")
			if err != nil {
				t.Fatalf("LoadMessages: %v", err)
			}
			if len(rows) != 1 {
				t.Fatalf("rows = %d, want 1", len(rows))
			}
			if rows[0].InjectionKind != string(tc.want) {
				t.Errorf("InjectionKind = %q, want %q", rows[0].InjectionKind, tc.want)
			}
			if !rows[0].MachineAuthored {
				t.Error("MachineAuthored = false: the row stays visible in the transcript")
			}
		})
	}
}

// TestLegacyRecoveryRepair_LeavesUserProseAboutAgentsAlone is the guard that
// keeps the signature set from becoming a prose matcher. An operator writes
// about dispatches constantly, and a row wrongly classified is a user message
// silently deleted from their own transcript — strictly worse than a leaked
// machine row.
//
// Every case here is text a user could plausibly type that shares a prefix
// with a machine shape but is not one.
func TestLegacyRecoveryRepair_LeavesUserProseAboutAgentsAlone(t *testing.T) {
	prose := []string{
		"[Agent Dev Lead completed in 472s] — why did this take so long?",
		"the [Agent Dev Lead completed] message never arrived",
		"[Agent Dev Lead completed] with no elapsed line at all",
		"[Agent Dev Lead] is stuck, can you check",
		"[Agent Dev Lead exploded]",
		"[Agent Dev Lead failed] but there was no colon",
		"[SYSTEM] Plan mode still active — but I never entered plan mode?",
		"[SYSTEM] Dispatch check-in should not fire this often",
		"[SYSTEM] some other thing entirely",
	}

	for _, text := range prose {
		t.Run(text[:min(len(text), 44)], func(t *testing.T) {
			conv := CreateConversation("legacy-prose-"+text[:min(len(text), 12)], "", "test-model")
			AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: text})
			if err := Save(conv, ""); err != nil {
				t.Fatalf("Save: %v", err)
			}

			rows, err := LoadMessages(conv.ID, "")
			if err != nil {
				t.Fatalf("LoadMessages: %v", err)
			}
			if len(rows) != 1 {
				t.Fatalf("rows = %d, want 1", len(rows))
			}
			if rows[0].InjectionKind != "" || rows[0].MachineAuthored {
				t.Errorf("user prose was classified as %q (machineAuthored %v) and would be hidden from the transcript",
					rows[0].InjectionKind, rows[0].MachineAuthored)
			}
		})
	}
}

func TestToContentBlocks_DecodesJSONRecoveredBlockSlices(t *testing.T) {
	blocks := toContentBlocks([]any{map[string]any{"type": "text", "text": "recover"}})
	if len(blocks) != 1 || blocks[0].Type != "text" || blocks[0].Text != "recover" {
		t.Fatalf("decoded blocks = %#v", blocks)
	}
}

// TestLegacyRecoveryRepair_ClassifiesRecoveryContinuation covers the rows that
// actually leaked into operators' transcripts.
//
// Run recovery injects RecoveryContinuationPrompt() as a machine-authored turn.
// When the interrupted run's original user turn carried an image, the replayed
// PromptOverrides carried the attachment too, the append took the attachment
// shape, and the classification was dropped — so the row persisted with no kind
// and no MachineAuthored. Both clients suppress on exactly those fields, so
// every such row rendered as a user message saying "[SYSTEM] This run was
// interrupted...".
//
// The forward fix (backend.appendInboundUserMessage) stops new rows from
// landing unclassified. This repair is what heals the conversations already on
// disk, so an operator's existing history stops showing the leak on reload.
//
// Revert-red: drop the recovery-continuation arm from
// legacyDispatchInjectionKind and this test fails, because the row reloads
// unclassified and therefore visible.
func TestLegacyRecoveryRepair_ClassifiesRecoveryContinuation(t *testing.T) {
	conv := CreateConversation("legacy-run-recovery", "", "test-model")
	AppendEntry(conv, EntryMessage, MessageData{
		Role:    "user",
		Content: RecoveryContinuationPrompt(),
	})
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	rows, err := LoadMessages(conv.ID, "")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if rows[0].InjectionKind != string(types.InjectionKindRunRecovery) {
		t.Errorf("InjectionKind = %q, want %q", rows[0].InjectionKind, types.InjectionKindRunRecovery)
	}
	if !rows[0].MachineAuthored {
		t.Error("MachineAuthored = false: the row stays visible in the transcript")
	}
}

// TestLegacyRecoveryRepair_ClassifiesRecoveryContinuationWithAttachment pins
// the exact production shape: the continuation prose in the first text block,
// followed by the replayed image block from the interrupted run's user turn.
// The signature match must read the leading text block and ignore the trailing
// structural blocks.
func TestLegacyRecoveryRepair_ClassifiesRecoveryContinuationWithAttachment(t *testing.T) {
	conv := CreateConversation("legacy-run-recovery-image", "", "test-model")
	AppendEntry(conv, EntryMessage, MessageData{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "text", Text: RecoveryContinuationPrompt()},
			{Type: "image", Source: &types.ImageSource{
				Type: "base64", MediaType: "image/png", Data: "aGVsbG8=",
			}},
		},
	})
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	rows, err := LoadMessages(conv.ID, "")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if rows[0].InjectionKind != string(types.InjectionKindRunRecovery) || !rows[0].MachineAuthored {
		t.Fatalf("classification = kind %q machineAuthored %v, want %q true",
			rows[0].InjectionKind, rows[0].MachineAuthored, types.InjectionKindRunRecovery)
	}
}
