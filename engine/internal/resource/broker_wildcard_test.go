package resource

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// collectDeliver returns a deliver func that appends every message into the
// provided slice pointer. Mirrors the inline pattern used elsewhere in this
// package's tests.
func collectDeliver(out *[]ResourceMessage) func(ResourceMessage) {
	return func(msg ResourceMessage) { *out = append(*out, msg) }
}

// TestBroker_SubscribeWildcard_AggregatesSnapshots verifies that a wildcard
// subscriber receives one snapshot per registered producing kind at subscribe
// time, each carrying the real kind (never "*").
func TestBroker_SubscribeWildcard_AggregatesSnapshots(t *testing.T) {
	b := NewBroker()
	if err := b.RegisterProducer("briefing", &mockProducer{items: []types.ResourceItem{
		{ID: "b1", Kind: "briefing", Content: "brief"},
	}}, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatalf("RegisterProducer briefing: %v", err)
	}
	if err := b.RegisterProducer("note", &mockProducer{items: []types.ResourceItem{
		{ID: "n1", Kind: "note", Content: "note"},
	}}, types.ResourceDeclaration{Kind: "note"}); err != nil {
		t.Fatalf("RegisterProducer note: %v", err)
	}

	var received []ResourceMessage
	b.SubscribeWildcard(types.ResourceFilter{}, collectDeliver(&received))

	if len(received) != 2 {
		t.Fatalf("expected 2 snapshot messages (one per kind), got %d", len(received))
	}
	kinds := map[string]bool{}
	for _, msg := range received {
		if msg.Type != "snapshot" {
			t.Errorf("expected type=snapshot, got %q", msg.Type)
		}
		if msg.Kind == WildcardKind {
			t.Errorf("wildcard snapshot must carry real kind, got %q", msg.Kind)
		}
		kinds[msg.Kind] = true
	}
	if !kinds["briefing"] || !kinds["note"] {
		t.Errorf("expected snapshots for briefing and note, got %v", kinds)
	}
}

// TestBroker_SubscribeWildcard_ReceivesAllKindDeltas verifies a wildcard
// subscriber receives deltas published to multiple distinct kinds, with each
// delta carrying its real kind.
func TestBroker_SubscribeWildcard_ReceivesAllKindDeltas(t *testing.T) {
	b := NewBroker()
	if err := b.RegisterProducer("briefing", &mockProducer{}, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatalf("RegisterProducer briefing: %v", err)
	}
	if err := b.RegisterProducer("note", &mockProducer{}, types.ResourceDeclaration{Kind: "note"}); err != nil {
		t.Fatalf("RegisterProducer note: %v", err)
	}

	var received []ResourceMessage
	b.SubscribeWildcard(types.ResourceFilter{}, collectDeliver(&received))
	// Drop the initial (empty) snapshots so we assert only on deltas.
	received = nil

	if err := b.Publish("briefing", types.ResourceDelta{Op: "create", Item: types.ResourceItem{ID: "b1", Kind: "briefing"}}); err != nil {
		t.Fatalf("Publish briefing: %v", err)
	}
	if err := b.Publish("note", types.ResourceDelta{Op: "create", Item: types.ResourceItem{ID: "n1", Kind: "note"}}); err != nil {
		t.Fatalf("Publish note: %v", err)
	}

	if len(received) != 2 {
		t.Fatalf("expected 2 deltas, got %d", len(received))
	}
	got := map[string]string{}
	for _, msg := range received {
		if msg.Type != "delta" {
			t.Errorf("expected type=delta, got %q", msg.Type)
		}
		got[msg.Kind] = msg.Delta.Item.ID
	}
	if got["briefing"] != "b1" || got["note"] != "n1" {
		t.Errorf("wildcard delta routing wrong: %v", got)
	}
}

// TestBroker_SubscribeWildcard_ReceivesLateRegisteredKind verifies that a
// kind registered AFTER the wildcard subscription still reaches the wildcard
// subscriber on publish — the wildcard streams future kinds, not just the
// kinds present at subscribe time.
func TestBroker_SubscribeWildcard_ReceivesLateRegisteredKind(t *testing.T) {
	b := NewBroker()

	var received []ResourceMessage
	b.SubscribeWildcard(types.ResourceFilter{}, collectDeliver(&received))
	received = nil // no producers at subscribe → no initial snapshots

	// Register a new kind after the subscription exists, then publish.
	if err := b.RegisterProducer("report", &mockProducer{}, types.ResourceDeclaration{Kind: "report"}); err != nil {
		t.Fatalf("RegisterProducer report: %v", err)
	}
	if err := b.Publish("report", types.ResourceDelta{Op: "create", Item: types.ResourceItem{ID: "r1", Kind: "report"}}); err != nil {
		t.Fatalf("Publish report: %v", err)
	}

	if len(received) != 1 {
		t.Fatalf("expected 1 delta for late-registered kind, got %d", len(received))
	}
	if received[0].Kind != "report" || received[0].Delta.Item.ID != "r1" {
		t.Errorf("late-kind delta wrong: kind=%q id=%q", received[0].Kind, received[0].Delta.Item.ID)
	}
}

// TestBroker_SubscribeWildcard_RespectsConversationFilter verifies that a
// conversation-scoped wildcard subscription only receives deltas matching its
// conversationId, exactly like an exact-kind conversation-scoped subscriber.
func TestBroker_SubscribeWildcard_RespectsConversationFilter(t *testing.T) {
	b := NewBroker()
	if err := b.RegisterProducer("briefing", &mockProducer{}, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatalf("RegisterProducer: %v", err)
	}

	var received []ResourceMessage
	b.SubscribeWildcard(types.ResourceFilter{ConversationID: "conv-1"}, collectDeliver(&received))
	received = nil

	// Matching conversation → delivered.
	_ = b.Publish("briefing", types.ResourceDelta{Op: "create", Item: types.ResourceItem{ID: "b1", Kind: "briefing", ConversationID: "conv-1"}})
	// Other conversation → filtered out.
	_ = b.Publish("briefing", types.ResourceDelta{Op: "create", Item: types.ResourceItem{ID: "b2", Kind: "briefing", ConversationID: "conv-2"}})

	if len(received) != 1 {
		t.Fatalf("expected 1 delta (filtered by conversationId), got %d", len(received))
	}
	if received[0].Delta.Item.ID != "b1" {
		t.Errorf("expected b1 (conv-1), got %q", received[0].Delta.Item.ID)
	}
}

// TestBroker_Wildcard_DoesNotAffectExactKind verifies an exact-kind subscriber
// continues to receive only its own kind's events when a wildcard subscriber
// coexists — the wildcard addition is non-breaking for existing subscribers.
func TestBroker_Wildcard_DoesNotAffectExactKind(t *testing.T) {
	b := NewBroker()
	if err := b.RegisterProducer("briefing", &mockProducer{}, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatalf("RegisterProducer briefing: %v", err)
	}
	if err := b.RegisterProducer("note", &mockProducer{}, types.ResourceDeclaration{Kind: "note"}); err != nil {
		t.Fatalf("RegisterProducer note: %v", err)
	}

	var exact []ResourceMessage
	if _, err := b.Subscribe("briefing", types.ResourceFilter{Kind: "briefing"}, collectDeliver(&exact)); err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	exact = nil // drop initial snapshot

	var wild []ResourceMessage
	b.SubscribeWildcard(types.ResourceFilter{}, collectDeliver(&wild))
	wild = nil

	_ = b.Publish("note", types.ResourceDelta{Op: "create", Item: types.ResourceItem{ID: "n1", Kind: "note"}})

	if len(exact) != 0 {
		t.Errorf("exact briefing subscriber must NOT receive note deltas, got %d", len(exact))
	}
	if len(wild) != 1 || wild[0].Kind != "note" {
		t.Errorf("wildcard subscriber should receive the note delta, got %v", wild)
	}
}

// TestBroker_SubscribeDirectWildcard_NoSnapshotStreamsDeltas verifies the
// producer-less global wildcard path: no initial snapshot query, but every
// kind's deltas are streamed.
func TestBroker_SubscribeDirectWildcard_NoSnapshotStreamsDeltas(t *testing.T) {
	b := NewBroker()

	var received []ResourceMessage
	b.SubscribeDirectWildcard(types.ResourceFilter{}, collectDeliver(&received))
	if len(received) != 0 {
		t.Fatalf("SubscribeDirectWildcard must not deliver an initial snapshot, got %d", len(received))
	}

	// PublishDirect (no producer required) for two client-invented kinds.
	b.PublishDirect("desktop.focus", types.ResourceDelta{Op: "update", Item: types.ResourceItem{ID: "f1", Kind: "desktop.focus"}})
	b.PublishDirect("client.state", types.ResourceDelta{Op: "update", Item: types.ResourceItem{ID: "c1", Kind: "client.state"}})

	if len(received) != 2 {
		t.Fatalf("expected 2 direct deltas, got %d", len(received))
	}
	kinds := map[string]bool{}
	for _, msg := range received {
		kinds[msg.Kind] = true
	}
	if !kinds["desktop.focus"] || !kinds["client.state"] {
		t.Errorf("expected both direct kinds, got %v", kinds)
	}
}

// TestBroker_Wildcard_Unsubscribe verifies a wildcard subscription stops
// receiving deltas after Unsubscribe.
func TestBroker_Wildcard_Unsubscribe(t *testing.T) {
	b := NewBroker()
	if err := b.RegisterProducer("briefing", &mockProducer{}, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatalf("RegisterProducer: %v", err)
	}

	var received []ResourceMessage
	sub := b.SubscribeWildcard(types.ResourceFilter{}, collectDeliver(&received))
	received = nil

	b.Unsubscribe(sub.ID)
	_ = b.Publish("briefing", types.ResourceDelta{Op: "create", Item: types.ResourceItem{ID: "b1", Kind: "briefing"}})

	if len(received) != 0 {
		t.Errorf("unsubscribed wildcard must receive nothing, got %d", len(received))
	}
}

// TestIsWildcard pins the sentinel semantics.
func TestIsWildcard(t *testing.T) {
	if !IsWildcard("*") {
		t.Error(`IsWildcard("*") should be true`)
	}
	if IsWildcard("briefing") {
		t.Error(`IsWildcard("briefing") should be false`)
	}
	if IsWildcard("") {
		t.Error(`IsWildcard("") should be false`)
	}
}
