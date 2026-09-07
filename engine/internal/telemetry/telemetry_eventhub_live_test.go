package telemetry

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azeventhubs/v2"
	"github.com/dsswift/ion/engine/internal/types"
)

// telemetry_eventhub_live_test.go exercises the SDK-backed sender against a
// real Event Hubs endpoint — the emulator in practice — because building an
// EventDataBatch needs a live AMQP link, so the negotiation and the size
// contract's interaction with the real transport cannot be proven with the
// fake. Skipped unless ION_EVENTHUB_LIVE_CONNECTION_STRING is set; the
// emulator's string is in docs/observability/eventhub-emulator.md.

func liveEventHubConfig(t *testing.T) types.TelemetryConfig {
	t.Helper()
	cs := os.Getenv("ION_EVENTHUB_LIVE_CONNECTION_STRING")
	if cs == "" {
		t.Skip("ION_EVENTHUB_LIVE_CONNECTION_STRING not set; live Event Hubs test skipped")
	}
	name := os.Getenv("ION_EVENTHUB_LIVE_NAME")
	if name == "" {
		name = "conversation-events"
	}
	return types.TelemetryConfig{Enabled: true, Targets: []string{"eventhub"}, EventHubConnectionString: cs, EventHubName: name}
}

// TestLiveEventHub_NegotiatesLimitAndRoundTripsSegmentedEvent sends an event
// several times the link limit and reads it back from the hub as parts that
// reassemble to the original — the whole size contract, against the real
// transport, end to end.
func TestLiveEventHub_NegotiatesLimitAndRoundTripsSegmentedEvent(t *testing.T) {
	cfg := liveEventHubConfig(t)
	t.Setenv("HOME", t.TempDir())
	c := NewCollector(cfg)
	defer c.Close()
	if c.eventHubSender == nil {
		t.Fatal("sender failed to construct; see the engine log")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	limit, err := c.eventHubSender.MaxMessageBytes(ctx)
	if err != nil {
		t.Fatalf("MaxMessageBytes: %v", err)
	}
	if limit < 64*1024 || limit > 64*1024*1024 {
		t.Fatalf("negotiated limit %d is not a plausible Event Hubs message size", limit)
	}
	t.Logf("negotiated link max message size: %d bytes", limit)

	// Record the partitions' tail so the read-back starts after our send.
	consumer, err := azeventhubs.NewConsumerClientFromConnectionString(cfg.EventHubConnectionString, cfg.EventHubName, azeventhubs.DefaultConsumerGroup, nil)
	if err != nil {
		t.Fatalf("consumer client: %v", err)
	}
	defer consumer.Close(ctx) //nolint:errcheck // test cleanup
	props, err := consumer.GetEventHubProperties(ctx, nil)
	if err != nil {
		t.Fatalf("hub properties: %v", err)
	}
	starts := map[string]azeventhubs.StartPosition{}
	for _, pid := range props.PartitionIDs {
		pp, err := consumer.GetPartitionProperties(ctx, pid, nil)
		if err != nil {
			t.Fatalf("partition %s properties: %v", pid, err)
		}
		seq := pp.LastEnqueuedSequenceNumber
		starts[pid] = azeventhubs.StartPosition{SequenceNumber: &seq}
	}

	original := awkwardText(3*limit+12_345, 9)
	marker := "live-" + time.Now().UTC().Format("150405.000000000")
	c.Event(ConversationToolCall, map[string]any{"conversation_id": marker, "tool_name": "Bash", "outcome": "success", "output": original}, nil)
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if c.eventHubRetry.load() != nil {
		t.Fatal("nothing should be queued after a successful live send")
	}

	// Read back every part for our marker across all partitions.
	var parts []Event
	deadline := time.Now().Add(60 * time.Second)
	for _, pid := range props.PartitionIDs {
		pc, err := consumer.NewPartitionClient(pid, &azeventhubs.PartitionClientOptions{StartPosition: starts[pid]})
		if err != nil {
			t.Fatalf("partition client %s: %v", pid, err)
		}
		for time.Now().Before(deadline) {
			rctx, rcancel := context.WithTimeout(ctx, 5*time.Second)
			evs, err := pc.ReceiveEvents(rctx, 100, nil)
			rcancel()
			if err != nil && !strings.Contains(err.Error(), "context deadline exceeded") {
				t.Fatalf("receive on partition %s: %v", pid, err)
			}
			if len(evs) == 0 {
				break
			}
			for _, ev := range evs {
				var e Event
				if err := json.Unmarshal(ev.Body, &e); err != nil {
					t.Fatalf("event body does not parse: %v", err)
				}
				if e.Payload["conversation_id"] == marker {
					parts = append(parts, e)
				}
			}
		}
		pc.Close(ctx) //nolint:errcheck // test cleanup
	}
	if len(parts) < 3 {
		t.Fatalf("read back %d parts, want at least 3 for a %d byte field on a %d byte link", len(parts), len(original), limit)
	}
	got, field, _ := reassemble(t, parts)
	if field != "/output" || got != original {
		t.Fatalf("reassembled %d bytes of %q that differ from the %d byte original", len(got), field, len(original))
	}
	t.Logf("round-tripped %d bytes as %d parts", len(original), len(parts))
}
