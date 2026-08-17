package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
)

func TestRecoverInterruptedRun_ExtensionSkipsRecovery(t *testing.T) {
	enabled := true
	m, s, _ := recoveryTestManager(t, enabled)
	conv := conversation.CreateConversation(s.conversationID, "", "test-model")
	conversation.BeginRunRecovery(conv, conversation.RunJournalEntry{RecoveryID: "recovery-skip", SessionKey: s.key, Prompt: "continue"})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	group := extension.NewExtensionGroup()
	host := extension.NewHost()
	host.SDK().On(extension.HookBeforeRunRecovery, func(_ *extension.Context, _ interface{}) (interface{}, error) {
		return extension.BeforeRunRecoveryResult{Action: "skip"}, nil
	})
	group.Add(host)
	s.extGroup = group

	if m.recoverInterruptedRun(s, s.key) {
		t.Fatal("extension skip must prevent recovery dispatch")
	}
	loaded, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if conversation.ActiveRunRecovery(loaded) != nil {
		t.Fatal("extension skip must clear durable recovery journal")
	}
}

func TestRecoverInterruptedRun_ExtensionReceivesOriginalModel(t *testing.T) {
	enabled := true
	m, s, _ := recoveryTestManager(t, enabled)
	conv := conversation.CreateConversation(s.conversationID, "", "test-model")
	conversation.BeginRunRecovery(conv, conversation.RunJournalEntry{
		RecoveryID: "recovery-model", SessionKey: s.key, Prompt: "continue", Model: "model-original",
	})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	group := extension.NewExtensionGroup()
	host := extension.NewHost()
	var received extension.BeforeRunRecoveryInfo
	host.SDK().On(extension.HookBeforeRunRecovery, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		received = payload.(extension.BeforeRunRecoveryInfo)
		return extension.BeforeRunRecoveryResult{Action: "skip"}, nil
	})
	group.Add(host)
	s.extGroup = group

	m.recoverInterruptedRun(s, s.key)
	if received.Model != "model-original" {
		t.Fatalf("Model = %q, want model-original", received.Model)
	}
}
