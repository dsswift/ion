package resource

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// mockProducer returns its fixed item slice for any query.
type mockProducer struct {
	items []types.ResourceItem
}

func (m *mockProducer) HandleQuery(filter types.ResourceFilter) ([]types.ResourceItem, error) {
	return m.items, nil
}

// --- helpers ---

func newBrokerWithProducer(t *testing.T, kind string, items []types.ResourceItem) (*Broker, *mockProducer) {
	t.Helper()
	b := NewBroker()
	mp := &mockProducer{items: items}
	if err := b.RegisterProducer(kind, mp, types.ResourceDeclaration{Kind: kind}); err != nil {
		t.Fatalf("RegisterProducer: %v", err)
	}
	return b, mp
}

// --- tests ---

func TestBroker_RegisterProducer(t *testing.T) {
	b := NewBroker()
	mp := &mockProducer{}

	if err := b.RegisterProducer("note", mp, types.ResourceDeclaration{Kind: "note"}); err != nil {
		t.Fatalf("first registration failed: %v", err)
	}

	// Duplicate registration must return an error.
	err := b.RegisterProducer("note", mp, types.ResourceDeclaration{Kind: "note"})
	if err == nil {
		t.Fatal("expected error on duplicate kind registration, got nil")
	}

	// Empty kind must return an error.
	b2 := NewBroker()
	if err := b2.RegisterProducer("", mp, types.ResourceDeclaration{}); err == nil {
		t.Fatal("expected error for empty kind, got nil")
	}
}

func TestBroker_Subscribe_Snapshot(t *testing.T) {
	items := []types.ResourceItem{
		{ID: "1", Kind: "note", Content: "hello"},
		{ID: "2", Kind: "note", Content: "world"},
	}
	b, _ := newBrokerWithProducer(t, "note", items)

	var received []ResourceMessage
	_, err := b.Subscribe("note", types.ResourceFilter{Kind: "note"}, func(msg ResourceMessage) {
		received = append(received, msg)
	})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	if len(received) != 1 {
		t.Fatalf("expected 1 snapshot message, got %d", len(received))
	}
	snap := received[0]
	if snap.Type != "snapshot" {
		t.Errorf("expected type=snapshot, got %q", snap.Type)
	}
	if len(snap.Items) != len(items) {
		t.Errorf("expected %d items in snapshot, got %d", len(items), len(snap.Items))
	}
}

func TestBroker_Subscribe_NoProducer(t *testing.T) {
	b := NewBroker()
	_, err := b.Subscribe("ghost", types.ResourceFilter{Kind: "ghost"}, func(ResourceMessage) {})
	if err == nil {
		t.Fatal("expected error subscribing to unregistered kind, got nil")
	}
}

func TestBroker_Publish_FanOut(t *testing.T) {
	b, _ := newBrokerWithProducer(t, "note", nil)

	var mu sync.Mutex
	// Only count delta deliveries, not the initial snapshot.
	deltas := map[string]int{}

	deliver := func(id string) func(ResourceMessage) {
		return func(msg ResourceMessage) {
			if msg.Type == "delta" {
				mu.Lock()
				deltas[id]++
				mu.Unlock()
			}
		}
	}

	sub1, _ := b.Subscribe("note", types.ResourceFilter{Kind: "note"}, deliver("sub1"))
	sub2, _ := b.Subscribe("note", types.ResourceFilter{Kind: "note"}, deliver("sub2"))
	_ = sub1
	_ = sub2

	delta := types.ResourceDelta{Op: "create", Item: types.ResourceItem{ID: "x", Kind: "note"}}
	if err := b.Publish("note", delta); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if deltas["sub1"] != 1 {
		t.Errorf("sub1: expected 1 delta delivery, got %d", deltas["sub1"])
	}
	if deltas["sub2"] != 1 {
		t.Errorf("sub2: expected 1 delta delivery, got %d", deltas["sub2"])
	}
}

func TestBroker_Publish_NoSubscribers(t *testing.T) {
	b, _ := newBrokerWithProducer(t, "note", nil)
	delta := types.ResourceDelta{Op: "create", Item: types.ResourceItem{ID: "x", Kind: "note"}}
	if err := b.Publish("note", delta); err != nil {
		t.Errorf("Publish with no subscribers returned error: %v", err)
	}
}

func TestBroker_Unsubscribe(t *testing.T) {
	b, _ := newBrokerWithProducer(t, "note", nil)

	var count int32
	sub, _ := b.Subscribe("note", types.ResourceFilter{Kind: "note"}, func(msg ResourceMessage) {
		atomic.AddInt32(&count, 1)
	})

	b.Unsubscribe(sub.ID)

	delta := types.ResourceDelta{Op: "create", Item: types.ResourceItem{ID: "y", Kind: "note"}}
	if err := b.Publish("note", delta); err != nil {
		t.Fatalf("Publish after unsubscribe: %v", err)
	}

	// count should still be 1 (from the snapshot delivery), not 2.
	if c := atomic.LoadInt32(&count); c != 1 {
		t.Errorf("expected 1 delivery (snapshot only), got %d", c)
	}
}

func TestBroker_DeregisterProducer(t *testing.T) {
	b, _ := newBrokerWithProducer(t, "note", nil)
	b.DeregisterProducer("note")

	delta := types.ResourceDelta{Op: "create", Item: types.ResourceItem{ID: "z", Kind: "note"}}
	err := b.Publish("note", delta)
	if err == nil {
		t.Fatal("expected error publishing after producer deregistered, got nil")
	}
}

func TestBroker_Concurrent(t *testing.T) {
	b, _ := newBrokerWithProducer(t, "note", nil)

	const goroutines = 20
	const publishes = 50

	var wg sync.WaitGroup

	// Concurrent publishers.
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < publishes; j++ {
				delta := types.ResourceDelta{
					Op:   "create",
					Item: types.ResourceItem{ID: fmt.Sprintf("%d-%d", n, j), Kind: "note"},
				}
				_ = b.Publish("note", delta)
			}
		}(i)
	}

	// Concurrent subscribers and unsubscribers.
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sub, err := b.Subscribe("note", types.ResourceFilter{Kind: "note"}, func(ResourceMessage) {})
			if err != nil {
				return
			}
			b.Unsubscribe(sub.ID)
		}()
	}

	wg.Wait()
}

func TestBroker_PublishDirect(t *testing.T) {
	b := NewBroker()

	// Subscribe directly (no producer required)
	var received []ResourceMessage
	sub := b.SubscribeDirect("client.state", types.ResourceFilter{Kind: "client.state"}, func(msg ResourceMessage) {
		received = append(received, msg)
	})

	// Should have received an empty snapshot
	if len(received) != 1 || received[0].Type != "snapshot" {
		t.Fatalf("expected 1 snapshot, got %d messages", len(received))
	}

	// PublishDirect without a registered producer — should not panic or error
	b.PublishDirect("client.state", types.ResourceDelta{
		Op: "create",
		Item: types.ResourceItem{
			ID:      "state-1",
			Kind:    "client.state",
			Content: `{"key":"value"}`,
		},
	})

	if len(received) != 2 {
		t.Fatalf("expected 2 messages (snapshot + delta), got %d", len(received))
	}
	if received[1].Type != "delta" || received[1].Delta.Item.ID != "state-1" {
		t.Fatalf("unexpected delta: %+v", received[1])
	}

	// Unsubscribe works normally
	b.Unsubscribe(sub.ID)
	b.PublishDirect("client.state", types.ResourceDelta{
		Op:   "create",
		Item: types.ResourceItem{ID: "state-2", Kind: "client.state"},
	})
	if len(received) != 2 {
		t.Fatalf("expected 2 messages after unsubscribe, got %d", len(received))
	}
}

func TestBroker_PublishDirect_NoSubscribers(t *testing.T) {
	b := NewBroker()
	// PublishDirect with no subscribers — should not panic
	b.PublishDirect("nonexistent", types.ResourceDelta{
		Op:   "create",
		Item: types.ResourceItem{ID: "x", Kind: "nonexistent"},
	})
}

func TestBroker_PublishDirect_ConversationIdFilter(t *testing.T) {
	b := NewBroker()

	// Conversation-scoped subscriber: receives only conv-1 items.
	var filtered []ResourceMessage
	b.SubscribeDirect("briefing", types.ResourceFilter{Kind: "briefing", ConversationID: "conv-1"}, func(msg ResourceMessage) {
		filtered = append(filtered, msg)
	})

	// Workspace-level subscriber: receives everything.
	var unfiltered []ResourceMessage
	b.SubscribeDirect("briefing", types.ResourceFilter{Kind: "briefing"}, func(msg ResourceMessage) {
		unfiltered = append(unfiltered, msg)
	})

	// Publish item for conv-1
	b.PublishDirect("briefing", types.ResourceDelta{
		Op:   "create",
		Item: types.ResourceItem{ID: "b1", Kind: "briefing", ConversationID: "conv-1"},
	})

	// Publish item for conv-2
	b.PublishDirect("briefing", types.ResourceDelta{
		Op:   "create",
		Item: types.ResourceItem{ID: "b2", Kind: "briefing", ConversationID: "conv-2"},
	})

	// Publish global item (no conversationId)
	b.PublishDirect("briefing", types.ResourceDelta{
		Op:   "create",
		Item: types.ResourceItem{ID: "b3", Kind: "briefing"},
	})

	// Filtered subscriber: only b1 (conv-1); b2 and b3 are dropped.
	var filteredDeltas []ResourceMessage
	for _, m := range filtered {
		if m.Type == "delta" {
			filteredDeltas = append(filteredDeltas, m)
		}
	}
	if len(filteredDeltas) != 1 {
		t.Fatalf("filtered subscriber expected 1 delta, got %d", len(filteredDeltas))
	}
	if filteredDeltas[0].Delta.Item.ID != "b1" {
		t.Fatalf("filtered subscriber expected item b1, got %s", filteredDeltas[0].Delta.Item.ID)
	}

	// Unfiltered subscriber: all 3 deltas.
	deltaCountAll := 0
	for _, m := range unfiltered {
		if m.Type == "delta" {
			deltaCountAll++
		}
	}
	if deltaCountAll != 3 {
		t.Fatalf("unfiltered subscriber expected 3 deltas, got %d", deltaCountAll)
	}
}

// TestBroker_RewireQueryHandlerAndResnapshot verifies the post-respawn recovery
// path: a subscriber that received an empty snapshot (because the initial query
// failed) gets a corrective snapshot with real data when the handler is rewired.
func TestBroker_RewireQueryHandlerAndResnapshot(t *testing.T) {
	// Register a producer with a handler that initially returns an error.
	b := NewBroker()
	fph := &FuncProducerHost{}
	if err := b.RegisterProducer("briefing", fph, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatalf("RegisterProducer: %v", err)
	}

	// Install a failing handler (simulates subprocess dead during initial query).
	b.SetQueryHandler("briefing", func(types.ResourceFilter) ([]types.ResourceItem, error) {
		return nil, fmt.Errorf("extension subprocess died during resource/query call")
	})

	// Subscribe — should receive an empty snapshot because the query fails.
	var received []ResourceMessage
	var mu sync.Mutex
	_, err := b.Subscribe("briefing", types.ResourceFilter{Kind: "briefing"}, func(msg ResourceMessage) {
		mu.Lock()
		received = append(received, msg)
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}

	mu.Lock()
	if len(received) != 1 || received[0].Type != "snapshot" || len(received[0].Items) != 0 {
		mu.Unlock()
		t.Fatalf("expected 1 empty snapshot after failed query, got %+v", received)
	}
	mu.Unlock()

	// Simulate respawn: wire a handler that returns real data.
	realItems := []types.ResourceItem{
		{ID: "brief-1", Kind: "briefing", Content: "First briefing"},
		{ID: "brief-2", Kind: "briefing", Content: "Second briefing"},
	}
	b.RewireQueryHandlerAndResnapshot("briefing", func(types.ResourceFilter) ([]types.ResourceItem, error) {
		return realItems, nil
	})

	// Subscriber should now have received a corrective snapshot with real data.
	mu.Lock()
	defer mu.Unlock()
	if len(received) != 2 {
		t.Fatalf("expected 2 messages (empty snapshot + corrective snapshot), got %d", len(received))
	}
	corrective := received[1]
	if corrective.Type != "snapshot" {
		t.Errorf("expected corrective message type=snapshot, got %q", corrective.Type)
	}
	if len(corrective.Items) != 2 {
		t.Errorf("expected 2 items in corrective snapshot, got %d", len(corrective.Items))
	}
}

// TestBroker_RewireQueryHandlerAndResnapshot_MultipleSubscribers verifies
// that all active subscribers receive the corrective snapshot, each queried
// with their own filter.
func TestBroker_RewireQueryHandlerAndResnapshot_MultipleSubscribers(t *testing.T) {
	b := NewBroker()
	fph := &FuncProducerHost{}
	if err := b.RegisterProducer("note", fph, types.ResourceDeclaration{Kind: "note"}); err != nil {
		t.Fatalf("RegisterProducer: %v", err)
	}

	// Start with a failing handler so both subscribers get empty snapshots.
	b.SetQueryHandler("note", func(types.ResourceFilter) ([]types.ResourceItem, error) {
		return nil, fmt.Errorf("subprocess died")
	})

	var mu sync.Mutex
	msgCount := map[string]int{}
	mkDeliver := func(id string) func(ResourceMessage) {
		return func(msg ResourceMessage) {
			mu.Lock()
			msgCount[id]++
			mu.Unlock()
		}
	}

	_, _ = b.Subscribe("note", types.ResourceFilter{Kind: "note"}, mkDeliver("sub1"))
	_, _ = b.Subscribe("note", types.ResourceFilter{Kind: "note"}, mkDeliver("sub2"))

	mu.Lock()
	if msgCount["sub1"] != 1 || msgCount["sub2"] != 1 {
		mu.Unlock()
		t.Fatalf("expected 1 empty snapshot per subscriber, got sub1=%d sub2=%d", msgCount["sub1"], msgCount["sub2"])
	}
	mu.Unlock()

	// Rewire: both subscribers should now receive a corrective snapshot.
	b.RewireQueryHandlerAndResnapshot("note", func(types.ResourceFilter) ([]types.ResourceItem, error) {
		return []types.ResourceItem{{ID: "n1", Kind: "note"}}, nil
	})

	mu.Lock()
	defer mu.Unlock()
	if msgCount["sub1"] != 2 {
		t.Errorf("sub1: expected 2 messages, got %d", msgCount["sub1"])
	}
	if msgCount["sub2"] != 2 {
		t.Errorf("sub2: expected 2 messages, got %d", msgCount["sub2"])
	}
}
