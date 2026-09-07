package telemetry

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// fakeEventHubSender lets tests exercise Collector's "eventhub" dispatch,
// retry-queue reuse, and Close() wiring without a live AMQP connection —
// building a real azeventhubs.EventDataBatch always requires one (see
// telemetry_eventhub.go), so the real SDK-backed sender is verified
// separately against the Event Hubs emulator.
type fakeEventHubSender struct {
	sendErr   error
	sent      [][]Event
	closeErr  error
	closeCall int
	// maxBytes is what MaxMessageBytes reports; zero means the published
	// 1 MiB default. maxErr makes negotiation fail instead.
	maxBytes int
	maxErr   error
	// rejectOnce, when non-nil, makes the next Send report that index as
	// too large for an empty batch (delivering the events before it), then
	// clears itself — the shape of a link disagreeing with the size check.
	rejectOnce *int
}

func (f *fakeEventHubSender) Send(_ context.Context, events []Event) error {
	if f.sendErr != nil {
		return f.sendErr
	}
	if f.rejectOnce != nil {
		i := *f.rejectOnce
		f.rejectOnce = nil
		if i > 0 {
			f.sent = append(f.sent, events[:i])
		}
		return &eventTooLargeError{Index: i, Bytes: 1, Name: events[i].Name, Cause: fmt.Errorf("fake: too large")}
	}
	f.sent = append(f.sent, events)
	return nil
}

func (f *fakeEventHubSender) MaxMessageBytes(_ context.Context) (int, error) {
	if f.maxErr != nil {
		return 0, f.maxErr
	}
	if f.maxBytes > 0 {
		return f.maxBytes, nil
	}
	return defaultEventHubMaxMessageBytes, nil
}

func (f *fakeEventHubSender) Close(_ context.Context) error {
	f.closeCall++
	return f.closeErr
}

// TestHasEventHubTarget pins the target-name recognition helper the same
// way hasHTTPTarget/hasOtelTarget are pinned.
func TestHasEventHubTarget(t *testing.T) {
	if hasEventHubTarget([]string{"file", "http"}) {
		t.Error("hasEventHubTarget(without eventhub) = true, want false")
	}
	if !hasEventHubTarget([]string{"eventhub"}) {
		t.Error("hasEventHubTarget([eventhub]) = false, want true")
	}
}

// TestCollector_Flush_EventHubDispatchesToSender pins the Flush() "eventhub"
// case: buffered events are handed to the configured sender.
func TestCollector_Flush_EventHubDispatchesToSender(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // no FilePath below; isolate the retry-queue fallback path
	c := NewCollector(types.TelemetryConfig{
		Enabled: true,
		Targets: []string{"eventhub"},
		// No EventHubConnectionString — NewCollector will fail to construct
		// a real sender and leave c.eventHubSender nil. Replace it with the
		// fake so this test never touches the network.
	})
	defer c.Close()

	fake := &fakeEventHubSender{}
	c.eventHubSender = fake

	c.Event("conversation.tool_call", map[string]any{"outcome": "success"}, nil)
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush() = %v, want nil", err)
	}
	if len(fake.sent) != 1 || len(fake.sent[0]) != 1 {
		t.Fatalf("fake sender received %v batches, want 1 batch of 1 event", fake.sent)
	}
	if fake.sent[0][0].Name != "conversation.tool_call" {
		t.Errorf("delivered event name = %q, want conversation.tool_call", fake.sent[0][0].Name)
	}
}

// TestCollector_Flush_EventHubFailureEnqueuesRatherThanDrops mirrors
// TestCollector_Flush_HTTPFailureEnqueuesRatherThanDrops for the "eventhub"
// target: a failed send must not silently drop the batch.
func TestCollector_Flush_EventHubFailureEnqueuesRatherThanDrops(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // no FilePath below; isolate the retry-queue fallback path
	c := NewCollector(types.TelemetryConfig{
		Enabled: true,
		Targets: []string{"eventhub"},
	})
	defer c.Close()

	c.eventHubSender = &fakeEventHubSender{sendErr: fmt.Errorf("amqp: link detached")}

	c.Event("conversation.tool_call", map[string]any{"outcome": "success"}, nil)
	if err := c.Flush(); err == nil {
		t.Fatal("expected Flush to report the event hub send failure")
	}

	if c.eventHubRetry == nil {
		t.Fatal("collector has no eventHubRetry queue even though \"eventhub\" is a configured target")
	}
	batches := c.eventHubRetry.load()
	if len(batches) != 1 {
		t.Fatalf("got %d queued batches after a failed flush, want 1 (the event must survive on disk)", len(batches))
	}
}

// TestCollector_EventHub_NoSenderFailsLoudly pins setupEventHubTarget's
// failure path: an unconfigured/invalid connection string must not silently
// discard events. flushToEventHub returns an explicit error, and Flush still
// routes it through the retry queue rather than dropping it.
func TestCollector_EventHub_NoSenderFailsLoudly(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // no FilePath below; isolate the retry-queue fallback path
	c := NewCollector(types.TelemetryConfig{
		Enabled: true,
		Targets: []string{"eventhub"},
		// EventHubConnectionString intentionally empty/invalid.
	})
	defer c.Close()

	if c.eventHubSender != nil {
		t.Fatal("expected nil eventHubSender for an empty connection string")
	}

	c.Event("conversation.tool_call", map[string]any{"outcome": "success"}, nil)
	if err := c.Flush(); err == nil {
		t.Fatal("expected Flush to fail loudly when no event hub sender is configured")
	}
	if c.eventHubRetry == nil || len(c.eventHubRetry.load()) != 1 {
		t.Fatal("event must still be preserved on disk even when the sender failed to construct")
	}
}

// TestEventHubRetryQueue_RedeliversOnRecovery exercises the shared
// retryQueue mechanism end to end for the "eventhub" target: a failed send
// is queued, and drainAndRetry redelivers it once the sender recovers and
// the backoff has elapsed — the same contract TestRetryQueue_* pins for
// "http", proving the two targets genuinely share one mechanism.
func TestEventHubRetryQueue_RedeliversOnRecovery(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // no FilePath below; isolate the retry-queue fallback path
	fake := &fakeEventHubSender{sendErr: fmt.Errorf("amqp: link detached")}
	c := NewCollector(types.TelemetryConfig{
		Enabled: true,
		Targets: []string{"eventhub"},
	})
	defer c.Close()
	c.eventHubSender = fake

	c.Event("conversation.tool_call", map[string]any{"outcome": "success"}, nil)
	if err := c.Flush(); err == nil {
		t.Fatal("expected the first send to fail")
	}

	batches := c.eventHubRetry.load()
	if len(batches) != 1 {
		t.Fatalf("got %d queued batches, want 1", len(batches))
	}
	batches[0].NextRetryAt = time.Now().Add(-time.Second).UnixMilli()
	c.eventHubRetry.save(batches)

	fake.sendErr = nil
	c.eventHubRetry.drainAndRetry()

	if len(fake.sent) != 1 {
		t.Fatalf("got %d delivered batches after recovery, want 1", len(fake.sent))
	}
	if len(c.eventHubRetry.load()) != 0 {
		t.Fatalf("got %d batches remaining after successful redelivery, want 0", len(c.eventHubRetry.load()))
	}
}

// TestCollector_Close_ClosesEventHubSender pins Close()'s responsibility to
// release the underlying AMQP connection exactly once, mirroring the
// otelBridge.Close() call in the same method.
func TestCollector_Close_ClosesEventHubSender(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // no FilePath below; isolate the retry-queue fallback path
	c := NewCollector(types.TelemetryConfig{
		Enabled: true,
		Targets: []string{"eventhub"},
	})
	fake := &fakeEventHubSender{}
	c.eventHubSender = fake

	c.Close()
	if fake.closeCall != 1 {
		t.Fatalf("eventHubSender.Close called %d times, want 1", fake.closeCall)
	}

	// Idempotent: a second Close() must not call Close on the sender again.
	c.Close()
	if fake.closeCall != 1 {
		t.Fatalf("eventHubSender.Close called %d times after second Close(), want still 1", fake.closeCall)
	}
}
