package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// fixedProducer is a ProducerHost that always returns a fixed item slice.
type fixedProducer struct {
	items []types.ResourceItem
}

func (p *fixedProducer) HandleQuery(_ types.ResourceFilter) ([]types.ResourceItem, error) {
	return p.items, nil
}

// emptyProducer is a ProducerHost that always returns an empty slice.
type emptyProducer struct{}

func (p *emptyProducer) HandleQuery(_ types.ResourceFilter) ([]types.ResourceItem, error) {
	return []types.ResourceItem{}, nil
}

// TestDispatchResourceGet_ReturnsItem is the end-to-end test for the
// resource_get command: a registered producer's item must arrive as an
// engine_resource_item event on the requesting connection, followed by a
// successful result frame.
//
// Path exercised: dispatch.go → dispatchResourceGet → Broker.GetItem →
// EngineEvent marshal → writeToClient → sendResult.
func TestDispatchResourceGet_ReturnsItem(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	// Start a session so the Manager creates a session broker for this key.
	startSession(t, conn, "rg-session", "req-rg-start")

	// Register a producer on the session broker.
	broker := srv.manager.ResourceBroker("rg-session")
	if broker == nil {
		t.Fatal("ResourceBroker returned nil after startSession")
	}
	producer := &fixedProducer{items: []types.ResourceItem{
		{
			ID:        "r-1",
			Kind:      "briefing",
			Title:     "Daily brief",
			Content:   "Full body here",
			CreatedAt: "2024-01-01T00:00:00Z",
		},
	}}
	if err := broker.RegisterProducer("briefing", producer, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatalf("RegisterProducer: %v", err)
	}

	// Send resource_get.
	sendJSON(t, conn, map[string]interface{}{
		"cmd":          "resource_get",
		"key":          "rg-session",
		"resourceKind": "briefing",
		"resourceId":   "r-1",
		"requestId":    "req-rg-1",
	})

	lines := readLines(t, conn, 12, 3*time.Second)

	// Find the engine_resource_item event.
	var itemLine string
	for _, l := range lines {
		if strings.Contains(l, "engine_resource_item") {
			itemLine = l
			break
		}
	}
	if itemLine == "" {
		t.Fatalf("no engine_resource_item event received; lines=%v", lines)
	}

	// Parse the ServerMessage envelope.
	var env struct {
		Event json.RawMessage `json:"event"`
	}
	if err := json.Unmarshal([]byte(itemLine), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	var ev struct {
		Type         string              `json:"type"`
		ResourceKind string              `json:"resourceKind"`
		ResourceItem *types.ResourceItem `json:"resourceItem"`
	}
	if err := json.Unmarshal(env.Event, &ev); err != nil {
		t.Fatalf("unmarshal event: %v", err)
	}
	if ev.Type != "engine_resource_item" {
		t.Errorf("event.type = %q, want engine_resource_item", ev.Type)
	}
	if ev.ResourceKind != "briefing" {
		t.Errorf("event.resourceKind = %q, want briefing", ev.ResourceKind)
	}
	if ev.ResourceItem == nil {
		t.Fatal("event.resourceItem is nil")
	}
	if ev.ResourceItem.ID != "r-1" {
		t.Errorf("resourceItem.id = %q, want r-1", ev.ResourceItem.ID)
	}
	if ev.ResourceItem.Content != "Full body here" {
		t.Errorf("resourceItem.content = %q, want 'Full body here'", ev.ResourceItem.Content)
	}

	// The result frame must report success.
	r := findResult(t, lines)
	if r == nil {
		t.Fatalf("no result frame received; lines=%v", lines)
	}
	if !r.OK {
		t.Errorf("result.ok = false, error = %q", r.Error)
	}
}

// TestDispatchResourceGet_NotFoundReturnsError verifies that when the producer
// holds no item for the requested ID, the engine returns an error result and
// does NOT emit an engine_resource_item event.
func TestDispatchResourceGet_NotFoundReturnsError(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	startSession(t, conn, "rg-notfound", "req-rg-nf-start")

	broker := srv.manager.ResourceBroker("rg-notfound")
	if broker == nil {
		t.Fatal("ResourceBroker returned nil after startSession")
	}
	// Producer returns an empty slice — item not found.
	if err := broker.RegisterProducer("note", &emptyProducer{}, types.ResourceDeclaration{Kind: "note"}); err != nil {
		t.Fatalf("RegisterProducer: %v", err)
	}

	sendJSON(t, conn, map[string]interface{}{
		"cmd":          "resource_get",
		"key":          "rg-notfound",
		"resourceKind": "note",
		"resourceId":   "missing-id",
		"requestId":    "req-rg-nf",
	})

	lines := readLines(t, conn, 8, 2*time.Second)

	// No engine_resource_item event should be emitted.
	for _, l := range lines {
		if strings.Contains(l, "engine_resource_item") {
			t.Errorf("unexpected engine_resource_item event: %s", l)
		}
	}

	// Result must report an error.
	r := findResult(t, lines)
	if r == nil {
		t.Fatalf("no result frame received; lines=%v", lines)
	}
	if r.OK {
		t.Error("result.ok = true, want false for not-found item")
	}
	if r.Error == "" {
		t.Error("result.error is empty, want a non-empty error message")
	}
}

// TestDispatchResourceGet_NoProducerReturnsError verifies that when no producer
// is registered for the requested kind, the engine returns an error result.
func TestDispatchResourceGet_NoProducerReturnsError(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	startSession(t, conn, "rg-noproducer", "req-rg-np-start")

	// Send resource_get for a kind with no registered producer.
	sendJSON(t, conn, map[string]interface{}{
		"cmd":          "resource_get",
		"key":          "rg-noproducer",
		"resourceKind": "unregistered-kind",
		"resourceId":   "any-id",
		"requestId":    "req-rg-np",
	})

	lines := readLines(t, conn, 8, 2*time.Second)

	// No engine_resource_item event.
	for _, l := range lines {
		if strings.Contains(l, "engine_resource_item") {
			t.Errorf("unexpected engine_resource_item event for unregistered kind: %s", l)
		}
	}

	r := findResult(t, lines)
	if r == nil {
		t.Fatalf("no result frame received; lines=%v", lines)
	}
	if r.OK {
		t.Error("result.ok = true, want false for unregistered kind")
	}
	if r.Error == "" {
		t.Error("result.error is empty, want a non-empty error message")
	}
}
