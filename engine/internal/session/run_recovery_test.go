package session

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/types"
)

func recoveryTestManager(t *testing.T, enabled bool) (*Manager, *engineSession, []types.EngineEvent) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	var mu sync.Mutex
	var events []types.EngineEvent
	m := &Manager{sessions: make(map[string]*engineSession), runKeyBindings: make(map[string]string), onEvent: func(_ string, event types.EngineEvent) {
		mu.Lock()
		events = append(events, event)
		mu.Unlock()
	}}
	key, convID := "recovery-tab", "recovery-conv"
	s := &engineSession{key: key, conversationID: convID, config: types.EngineConfig{RunRecovery: &types.RunRecoveryConfig{Enabled: &enabled}}, agents: agents.NewRegistry(), dispatchRegistry: extcontext.NewDispatchRegistry(), pending: pending.New()}
	m.sessions[key] = s
	return m, s, events
}

func conversationBlocks(content any) []types.LlmContentBlock {
	switch value := content.(type) {
	case []types.LlmContentBlock:
		return value
	case []any:
		blocks := make([]types.LlmContentBlock, 0, len(value))
		for _, item := range value {
			block, ok := item.(map[string]any)
			if !ok {
				continue
			}
			decoded := types.LlmContentBlock{}
			switch block["type"] {
			case "text":
				decoded.Type, _ = block["type"].(string)
				decoded.Text, _ = block["text"].(string)
			case "image", "document":
				decoded.Type, _ = block["type"].(string)
				if source, ok := block["source"].(map[string]any); ok {
					decoded.Source = &types.ImageSource{}
					decoded.Source.Type, _ = source["type"].(string)
					decoded.Source.MediaType, _ = source["media_type"].(string)
					decoded.Source.Data, _ = source["data"].(string)
				}
			}
			blocks = append(blocks, decoded)
		}
		return blocks
	default:
		return nil
	}
}
func TestRecoveryPolicy_DefaultOff(t *testing.T) {
	m := &Manager{}
	if m.recoveryEnabled(&types.EngineConfig{}) {
		t.Fatal("recovery must be off when every layer omits it")
	}
}

func TestRecoveryPolicy_SessionOverridesEngine(t *testing.T) {
	global := true
	disabled := false
	m := &Manager{config: &types.EngineRuntimeConfig{RunRecovery: &types.RunRecoveryConfig{Enabled: &global}}}
	if !m.recoveryEnabled(&types.EngineConfig{}) {
		t.Fatal("engine-wide recovery default was not applied")
	}
	if m.recoveryEnabled(&types.EngineConfig{RunRecovery: &types.RunRecoveryConfig{Enabled: &disabled}}) {
		t.Fatal("session-level disable did not override engine default")
	}
}

func TestRecoverInterruptedRun_EmitsExhaustedWithoutDispatch(t *testing.T) {
	enabled := true
	m, s, _ := recoveryTestManager(t, enabled)
	conv := conversation.CreateConversation(s.conversationID, "", "test-model")
	conversation.BeginRunRecovery(conv, conversation.RunJournalEntry{RecoveryID: "recovery-id", SessionKey: s.key, Prompt: "continue", AttemptCount: types.RunRecoveryDefaultMaxAttempts})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if m.recoverInterruptedRun(s, s.key) {
		t.Fatal("exhausted recovery must not dispatch")
	}
	loaded, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if conversation.ActiveRunRecovery(loaded) != nil {
		t.Fatal("exhausted recovery must clear journal")
	}
}

func TestRecordRunRecovery_PersistsOneCanonicalUserTurn(t *testing.T) {
	enabled := true
	m, s, _ := recoveryTestManager(t, enabled)
	opts := types.RunOptions{Prompt: "perform durable work", Model: "test-model"}
	m.recordRunRecovery(s, s.key, "run-one", opts, nil)

	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(conv.Entries) != 1 {
		t.Fatalf("entries = %d, want one canonical user turn", len(conv.Entries))
	}
	journal := conversation.ActiveRunRecovery(conv)
	if journal == nil || journal.UserEntryID != conv.Entries[0].ID {
		t.Fatalf("journal user entry = %+v, want %q", journal, conv.Entries[0].ID)
	}
}

func TestRecordRunRecovery_PreservesCanonicalAttachmentBlocks(t *testing.T) {
	enabled := true
	m, s, _ := recoveryTestManager(t, enabled)
	opts := types.RunOptions{
		Prompt: "[Attachment: image.png (content attached)]\n\ninspect this",
		Model:  "test-model",
		Attachments: []types.ImageAttachment{
			{MediaType: "image/png", Data: "aW1hZ2U=", Path: "/tmp/image.png"},
			{MediaType: "application/pdf", Data: "cGRm", Path: "/tmp/report.pdf"},
		},
	}
	m.recordRunRecovery(s, s.key, "run-attachment", opts, nil)

	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(conv.Entries) != 1 {
		t.Fatalf("entries = %d, want one", len(conv.Entries))
	}
	entry, ok := conv.Entries[0].Data.(conversation.MessageData)
	if !ok {
		t.Fatalf("entry data = %T, want MessageData", conv.Entries[0].Data)
	}
	blocks := conversationBlocks(entry.Content)
	if len(blocks) != 3 || blocks[0].Type != "image" || blocks[0].Source == nil || blocks[0].Source.Data != "aW1hZ2U=" || blocks[1].Type != "document" || blocks[1].Source == nil || blocks[1].Source.Data != "cGRm" {
		t.Fatalf("recovery attachment blocks = %#v", blocks)
	}
	journal := conversation.ActiveRunRecovery(conv)
	if journal == nil || journal.UserEntryID != conv.Entries[0].ID {
		t.Fatalf("journal user entry = %+v, want %q", journal, conv.Entries[0].ID)
	}
}
func TestRecoverInterruptedRun_MarksAttemptBeforeDispatch(t *testing.T) {
	enabled := true
	m, s, _ := recoveryTestManager(t, enabled)
	conv := conversation.CreateConversation(s.conversationID, "", "test-model")
	conversation.BeginRunRecovery(conv, conversation.RunJournalEntry{RecoveryID: "recovery-id", SessionKey: s.key, Prompt: "continue"})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if !m.recoverInterruptedRun(s, s.key) {
		t.Fatal("expected journaled run to schedule recovery")
	}
	loaded, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if journal := conversation.ActiveRunRecovery(loaded); journal == nil || journal.AttemptCount != 1 {
		t.Fatalf("recovery attempt was not durably recorded: %+v", journal)
	}
}

func TestStopSession_ClearsJournalOnExplicitStop(t *testing.T) {
	enabled := true
	m, s, _ := recoveryTestManager(t, enabled)
	conv := conversation.CreateConversation(s.conversationID, "", "test-model")
	conversation.BeginRunRecovery(conv, conversation.RunJournalEntry{
		RecoveryID: "recovery-explicit", SessionKey: s.key, Prompt: "continue",
	})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	m.clearRunRecovery(s.conversationID, s.key, "explicit_stop")
	loaded, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if conversation.ActiveRunRecovery(loaded) != nil {
		t.Fatal("journal should be cleared on explicit stop")
	}
}

func TestShutdown_PreservesJournal(t *testing.T) {
	enabled := true
	m, s, _ := recoveryTestManager(t, enabled)
	conv := conversation.CreateConversation(s.conversationID, "", "test-model")
	conversation.BeginRunRecovery(conv, conversation.RunJournalEntry{
		RecoveryID: "recovery-shutdown", SessionKey: s.key, Prompt: "continue",
	})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	m.shuttingDown = true
	if !m.shuttingDown {
		t.Fatal("shuttingDown flag not set")
	}
	loaded, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if journal := conversation.ActiveRunRecovery(loaded); journal == nil {
		t.Fatal("journal should be preserved during shutdown")
	}
	if journal := conversation.ActiveRunRecovery(loaded); journal.RecoveryID != "recovery-shutdown" {
		t.Fatalf("journal recoveryID = %q, want recovery-shutdown", journal.RecoveryID)
	}
}
