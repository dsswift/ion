package resource

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestBroker_FuncProducerHost_Lifecycle validates the full resource lifecycle:
// declare a kind with a FuncProducerHost, set the query handler, subscribe
// (snapshot), publish a delta, then unsubscribe and verify silence.
func TestBroker_FuncProducerHost_Lifecycle(t *testing.T) {
	b := NewBroker()

	// Register a FuncProducerHost for the "briefing" kind.
	host := &FuncProducerHost{}
	if err := b.RegisterProducer("briefing", host, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatalf("RegisterProducer: %v", err)
	}

	// Wire the query handler (simulates HandleResourceQuery call from extension).
	b.SetQueryHandler("briefing", func(_ types.ResourceFilter) ([]types.ResourceItem, error) {
		return []types.ResourceItem{
			{
				ID:        "b1",
				Kind:      "briefing",
				Title:     "Morning Brief",
				Content:   "# Good morning",
				CreatedAt: "2026-06-05T08:00:00Z",
			},
		}, nil
	})

	// Subscribe — should receive an immediate snapshot with 1 item.
	var received []ResourceMessage
	sub, err := b.Subscribe("briefing", types.ResourceFilter{Kind: "briefing"}, func(msg ResourceMessage) {
		received = append(received, msg)
	})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}

	// Verify snapshot.
	if len(received) != 1 {
		t.Fatalf("expected 1 message after subscribe, got %d", len(received))
	}
	snap := received[0]
	if snap.Type != "snapshot" {
		t.Errorf("expected type=snapshot, got %q", snap.Type)
	}
	if len(snap.Items) != 1 {
		t.Fatalf("expected 1 item in snapshot, got %d", len(snap.Items))
	}
	if snap.Items[0].Title != "Morning Brief" {
		t.Errorf("snapshot item title: want %q, got %q", "Morning Brief", snap.Items[0].Title)
	}

	// Publish a delta — should arrive at the subscriber.
	err = b.Publish("briefing", types.ResourceDelta{
		Op: "create",
		Item: types.ResourceItem{
			ID:        "b2",
			Kind:      "briefing",
			Title:     "Evening Summary",
			Content:   "# Summary",
			CreatedAt: "2026-06-05T20:00:00Z",
		},
	})
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}

	// Verify delta received.
	if len(received) != 2 {
		t.Fatalf("expected 2 messages (snapshot + delta), got %d", len(received))
	}
	delta := received[1]
	if delta.Type != "delta" {
		t.Errorf("expected type=delta, got %q", delta.Type)
	}
	if delta.Delta == nil {
		t.Fatal("delta message has nil Delta field")
	}
	if delta.Delta.Item.Title != "Evening Summary" {
		t.Errorf("delta item title: want %q, got %q", "Evening Summary", delta.Delta.Item.Title)
	}

	// Unsubscribe — subsequent publishes must not reach the callback.
	b.Unsubscribe(sub.ID)

	err = b.Publish("briefing", types.ResourceDelta{
		Op:   "create",
		Item: types.ResourceItem{ID: "b3", Kind: "briefing", Content: "should not arrive"},
	})
	if err != nil {
		t.Fatalf("Publish after unsubscribe: %v", err)
	}

	if len(received) != 2 {
		t.Fatalf("expected exactly 2 messages after unsubscribe, got %d", len(received))
	}
}
