package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
)

func TestReserveDeliveryID_DeduplicatesInFlightPrompt(t *testing.T) {
	mgr := NewManager(newMockBackend())
	if _, err := mgr.StartSession("delivery", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	if !mgr.ReserveDeliveryID("delivery", "delivery-1") {
		t.Fatal("first reservation was rejected")
	}
	if mgr.ReserveDeliveryID("delivery", "delivery-1") {
		t.Fatal("duplicate in-flight reservation was accepted")
	}
}

func TestReserveDeliveryID_DeduplicatesPersistedPrompt(t *testing.T) {
	mgr := NewManager(newMockBackend())
	config := defaultConfig()
	config.SessionID = "persisted-delivery"
	if _, err := mgr.StartSession("delivery", config); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	conv := conversation.CreateConversation("persisted-delivery", "system", "model")
	conversation.AddUserMessageWithDeliveryIDs(conv, "persisted prompt", "", []string{"delivery-persisted"})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	if mgr.ReserveDeliveryID("delivery", "delivery-persisted") {
		t.Fatal("persisted delivery ID was accepted")
	}
}

func TestSendPrompt_ReleasesDeliveryIDAfterNoRun(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	if _, err := mgr.StartSession("delivery", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	overrides := &PromptOverrides{DeliveryId: "delivery-unknown", ResolveSlash: true}
	if !mgr.ReserveDeliveryID("delivery", overrides.DeliveryId) {
		t.Fatal("initial reservation was rejected")
	}
	if err := mgr.SendPrompt("delivery", "/does-not-exist", overrides); err != nil {
		t.Fatalf("unknown slash should decline without an error: %v", err)
	}
	if got := len(mb.startedKeys()); got != 0 {
		t.Fatalf("unknown slash started %d runs, want 0", got)
	}
	if !mgr.ReserveDeliveryID("delivery", overrides.DeliveryId) {
		t.Fatal("delivery ID remained reserved after no-run slash rejection")
	}
}

func TestSendPrompt_KeepsDeliveryIDAfterRunStarts(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	if _, err := mgr.StartSession("delivery", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	overrides := &PromptOverrides{DeliveryId: "delivery-started"}
	if !mgr.ReserveDeliveryID("delivery", overrides.DeliveryId) {
		t.Fatal("initial reservation was rejected")
	}
	if err := mgr.SendPrompt("delivery", "start the run", overrides); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	if got := len(mb.startedKeys()); got != 1 {
		t.Fatalf("started runs = %d, want 1", got)
	}
	if mgr.ReserveDeliveryID("delivery", overrides.DeliveryId) {
		t.Fatal("delivery ID was released after a run started")
	}
}
