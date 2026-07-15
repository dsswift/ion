package server

import (
	"net"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestClientBackpressureEmitDirect verifies emitBackpressure emits a
// client.backpressure telemetry event carrying the queue, dropped total, and
// listener flag, and is a no-op when no collector is installed. Goes red if the
// emit shape drifts.
func TestClientBackpressureEmitDirect(t *testing.T) {
	srv := &Server{}
	// No collector installed → must be a silent no-op (no panic).
	srv.emitBackpressure("stream", 5, false)

	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	srv.SetTelemetry(col)
	srv.emitBackpressure("state", 42, true)

	var found *telemetry.Event
	events := col.BufferedEvents()
	for i := range events {
		if events[i].Name == telemetry.ClientBackpressure {
			found = &events[i]
			break
		}
	}
	if found == nil {
		t.Fatal("expected a client.backpressure event")
	}
	if found.Payload["queue"] != "state" {
		t.Errorf("queue = %v, want state", found.Payload["queue"])
	}
	if found.Payload["dropped_total"] != int64(42) {
		t.Errorf("dropped_total = %v, want 42", found.Payload["dropped_total"])
	}
	if found.Payload["listener"] != true {
		t.Errorf("listener = %v, want true", found.Payload["listener"])
	}
}

// TestClientBackpressureFromBroadcast drives the real broadcast overflow path:
// a slow client that never reads causes its outbound queue to fill, and the
// broadcast default arm emits client.backpressure. Goes red if the emit is
// removed from broadcast's default arms.
func TestClientBackpressureFromBroadcast(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	srv.SetTelemetry(col)

	slow, err := net.Dial("unix", srv.SocketPath())
	if err != nil {
		t.Fatalf("dial slow: %v", err)
	}
	defer slow.Close()

	// Wait for the server to register the client.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		srv.mu.RLock()
		n := len(srv.clients)
		srv.mu.RUnlock()
		if n >= 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Slow client never reads. Flood broadcasts to overflow its stream queue.
	payload := make([]byte, 511)
	for i := range payload {
		payload[i] = 'x'
	}
	line := string(payload) + "\n"
	for i := 0; i < streamQueueSize*8; i++ {
		srv.broadcast(line, "engine_text_delta")
	}

	// At least one client.backpressure event must have fired.
	found := false
	for _, e := range col.BufferedEvents() {
		if e.Name == telemetry.ClientBackpressure {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected at least one client.backpressure event from broadcast overflow")
	}
}
