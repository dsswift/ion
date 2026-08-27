package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

type blockingWorkspaceProducer struct {
	started chan struct{}
	release chan struct{}
	items   []types.ResourceItem
}

func (p *blockingWorkspaceProducer) HandleQuery(types.ResourceFilter) ([]types.ResourceItem, error) {
	close(p.started)
	<-p.release
	return p.items, nil
}

func TestDispatchResourceSubscribe_GlobalWildcardReturnsExistingWorkspaceSnapshot(t *testing.T) {
	server := newShortPathTestServer(t, newMockBackend())
	connection := dialServer(t, server)
	defer connection.Close()
	startSession(t, connection, "resource-owner", "resource-owner-start")

	broker := server.manager.ResourceBroker("resource-owner")
	if broker == nil {
		t.Fatal("resource broker missing after session start")
	}
	if err := broker.RegisterProducerFor("briefing", "producer-a", &fixedProducer{items: []types.ResourceItem{{
		ID: "existing", Kind: "briefing", Content: "existing body",
	}}}, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatal(err)
	}

	sendJSON(t, connection, map[string]interface{}{
		"cmd": "resource_subscribe", "key": "", "resourceKind": "*",
		"resourceGlobal": true, "requestId": "global-subscribe",
	})
	lines := readLines(t, connection, 12, 3*time.Second)

	var snapshot struct {
		Type              string               `json:"type"`
		ResourceItems     []types.ResourceItem `json:"resourceItems"`
		ResourceProducers []string             `json:"resourceProducers"`
	}
	for _, line := range lines {
		if !strings.Contains(line, "engine_resource_snapshot") {
			continue
		}
		var envelope struct {
			Event json.RawMessage `json:"event"`
		}
		if err := json.Unmarshal([]byte(line), &envelope); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(envelope.Event, &snapshot); err != nil {
			t.Fatal(err)
		}
		break
	}
	if snapshot.Type != "engine_resource_snapshot" {
		t.Fatalf("no resource snapshot received; lines=%v", lines)
	}
	if len(snapshot.ResourceItems) != 1 || snapshot.ResourceItems[0].ID != "existing" {
		t.Fatalf("snapshot items = %+v, want existing item", snapshot.ResourceItems)
	}
	if len(snapshot.ResourceProducers) != 1 || snapshot.ResourceProducers[0] != "producer-a" {
		t.Fatalf("snapshot producers = %v, want [producer-a]", snapshot.ResourceProducers)
	}
}

func TestDispatchResourceSubscribe_GlobalKindReturnsExistingWorkspaceSnapshot(t *testing.T) {
	server := newShortPathTestServer(t, newMockBackend())
	connection := dialServer(t, server)
	defer connection.Close()
	startSession(t, connection, "resource-kind-owner", "resource-kind-start")

	broker := server.manager.ResourceBroker("resource-kind-owner")
	if broker == nil {
		t.Fatal("resource broker missing after session start")
	}
	if err := broker.RegisterProducerFor("briefing", "producer-a", &fixedProducer{items: []types.ResourceItem{{
		ID: "existing", Kind: "briefing", Content: "existing body",
	}}}, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatal(err)
	}

	sendJSON(t, connection, map[string]interface{}{
		"cmd": "resource_subscribe", "key": "", "resourceKind": "briefing",
		"resourceGlobal": true, "requestId": "global-kind-subscribe",
	})
	lines := readLines(t, connection, 12, 3*time.Second)
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, `"type":"engine_resource_snapshot"`) ||
		!strings.Contains(joined, `"resourceProducers":["producer-a"]`) ||
		!strings.Contains(joined, `"id":"existing"`) {
		t.Fatalf("global kind snapshot missing existing item or coverage; lines=%v", lines)
	}
}

func TestDispatchResourceSubscribe_GlobalWildcardOrdersSnapshotBeforeConcurrentDelta(t *testing.T) {
	server := newShortPathTestServer(t, newMockBackend())
	connection := dialServer(t, server)
	defer connection.Close()
	startSession(t, connection, "resource-order-owner", "resource-order-start")

	producer := &blockingWorkspaceProducer{
		started: make(chan struct{}),
		release: make(chan struct{}),
		items:   []types.ResourceItem{{ID: "old", Kind: "briefing", Content: "old body"}},
	}
	broker := server.manager.ResourceBroker("resource-order-owner")
	if broker == nil {
		t.Fatal("resource broker missing after session start")
	}
	if err := broker.RegisterProducerFor("briefing", "producer-a", producer, types.ResourceDeclaration{Kind: "briefing"}); err != nil {
		t.Fatal(err)
	}

	sendJSON(t, connection, map[string]interface{}{
		"cmd": "resource_subscribe", "key": "", "resourceKind": "*",
		"resourceGlobal": true, "requestId": "ordered-subscribe",
	})
	select {
	case <-producer.started:
	case <-time.After(2 * time.Second):
		t.Fatal("workspace snapshot query did not start")
	}
	server.manager.GlobalResourceBroker().PublishDirect("briefing", types.ResourceDelta{
		Op: "update",
		Item: types.ResourceItem{
			ID: "new", Kind: "briefing", Producer: "producer-a", Content: "new body", CreatedAt: "2026-01-01T00:00:00Z",
		},
	})
	close(producer.release)
	lines := readLines(t, connection, 16, 3*time.Second)

	var orderedTypes []string
	for _, line := range lines {
		if strings.Contains(line, "engine_resource_snapshot") {
			orderedTypes = append(orderedTypes, "snapshot")
		}
		if strings.Contains(line, "engine_resource_delta") {
			orderedTypes = append(orderedTypes, "delta")
		}
	}
	if len(orderedTypes) < 2 || orderedTypes[0] != "snapshot" || orderedTypes[1] != "delta" {
		t.Fatalf("resource event order = %v, want [snapshot delta]; lines=%v", orderedTypes, lines)
	}
}
