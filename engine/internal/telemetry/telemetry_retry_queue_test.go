package telemetry

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestRetryQueue_FailedBatchSurvivesAndRedelivers pins the durability fix: a
// batch that fails to deliver is NOT dropped (the pre-fix behavior — Flush
// cleared its buffer unconditionally before attempting delivery) but
// persisted to the on-disk retry queue, and a later drainAndRetry call
// redelivers it once the target recovers. Reverting the enqueue call in
// Collector.Flush's "http" case makes this test fail: the queue file would
// never be written and drainAndRetry would have nothing to redeliver.
func TestRetryQueue_FailedBatchSurvivesAndRedelivers(t *testing.T) {
	var received atomic.Int32
	var fail atomic.Bool
	fail.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		received.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	dir := t.TempDir()
	queuePath := filepath.Join(dir, "retry.jsonl")
	deliver := func(events []Event) ([]Event, error) {
		if err := flushToHTTP(events, server.URL, nil); err != nil {
			return events, err
		}
		return nil, nil
	}
	q := newRetryQueue("http", queuePath, 20, 0, 0, deliver)

	events := []Event{{Name: "conversation.tool_call", Payload: map[string]any{"outcome": "success"}}}

	// Simulate what Collector.Flush does on a failed delivery: enqueue
	// instead of dropping.
	if _, err := deliver(events); err == nil {
		t.Fatal("expected the first POST (server returning 503) to fail")
	}
	q.enqueue(events)

	// The queue file must exist on disk now — this is the "not silently
	// dropped" assertion.
	batches := q.load()
	if len(batches) != 1 || len(batches[0].Events) != 1 {
		t.Fatalf("got %d queued batches, want 1 with 1 event: %+v", len(batches), batches)
	}

	// Backoff has not elapsed yet — draining now must not deliver (and must
	// not delete the queued batch).
	q.drainAndRetry()
	if received.Load() != 0 {
		t.Fatalf("got %d delivered before backoff elapsed, want 0", received.Load())
	}
	if len(q.load()) != 1 {
		t.Fatal("batch disappeared from the queue before its backoff elapsed")
	}

	// Force the backoff to have elapsed and let the server start accepting.
	batches = q.load()
	batches[0].NextRetryAt = time.Now().Add(-time.Second).UnixMilli()
	q.save(batches)
	fail.Store(false)

	q.drainAndRetry()
	if received.Load() != 1 {
		t.Fatalf("got %d delivered after recovery, want 1 (batch should have been redelivered)", received.Load())
	}
	if len(q.load()) != 0 {
		t.Fatalf("got %d batches remaining after successful redelivery, want 0", len(q.load()))
	}
}

// TestCollector_Flush_HTTPFailureEnqueuesRatherThanDrops exercises the real
// Collector end to end: Flush must not lose a batch when the http POST
// fails. Before the retry queue existed, Flush cleared its buffer
// unconditionally and flushToHTTP's error was the only trace of the failed
// batch — nothing preserved the events. This test fails on that behavior
// (Collector.httpRetry.load() would be empty) and passes with the fix.
func TestCollector_Flush_HTTPFailureEnqueuesRatherThanDrops(t *testing.T) {
	// No FilePath is configured below, so retryQueuePath falls back to a
	// path under the home directory — isolate it so this test never touches
	// the real operator's ~/.ion.
	t.Setenv("HOME", t.TempDir())

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	c := NewCollector(types.TelemetryConfig{
		Enabled:      true,
		Targets:      []string{"http"},
		HttpEndpoint: server.URL,
	})
	defer c.Close()

	c.Event("conversation.tool_call", map[string]any{"outcome": "success"}, nil)
	if err := c.Flush(); err == nil {
		t.Fatal("expected Flush to report the http failure")
	}

	if c.httpRetry == nil {
		t.Fatal("collector has no httpRetry queue even though \"http\" is a configured target")
	}
	batches := c.httpRetry.load()
	if len(batches) != 1 {
		t.Fatalf("got %d queued batches after a failed flush, want 1 (the event must survive on disk)", len(batches))
	}
}

// TestRetryQueue_OverCapDropsOldestWithLog pins the bounded-queue
// requirement: enqueue never grows the on-disk queue past maxBytes, and it
// drops the OLDEST batch first rather than the newest or a random one.
func TestRetryQueue_OverCapDropsOldestWithLog(t *testing.T) {
	dir := t.TempDir()
	q := newRetryQueue("http", filepath.Join(dir, "retry.jsonl"), 0, 0, 0, func([]Event) ([]Event, error) { return nil, nil })
	// A tiny cap forces eviction on the second enqueue.
	q.maxBytes = 200

	q.enqueue([]Event{{Name: "first", Payload: map[string]any{"marker": "oldest"}}})
	q.enqueue([]Event{{Name: "second", Payload: map[string]any{"marker": "newest", "pad": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}})

	batches := q.load()
	if len(batches) != 1 {
		t.Fatalf("got %d batches after over-cap enqueue, want exactly 1 (oldest evicted)", len(batches))
	}
	if batches[0].Events[0].Name != "second" {
		t.Errorf("surviving batch = %q, want the newest (%q) — oldest should have been dropped", batches[0].Events[0].Name, "second")
	}
}

// TestRetryQueue_UnboundedByDefaultNeverDrops is the regression test for the
// audit-loss defect (issue #379): the queue defaulted to a 20 MB cap and
// dropped the oldest batches of a sustained outage, which is exactly the
// data an operator enabled conversation events to keep. With no explicit
// cap configured the queue must retain everything, however far behind it
// gets.
//
// Fails on the pre-fix code: newRetryQueue substituted a 20 MB default for
// maxMB <= 0, so this loop's payload would have evicted its own earliest
// batches.
func TestRetryQueue_UnboundedByDefaultNeverDrops(t *testing.T) {
	dir := t.TempDir()
	q := newRetryQueue("http", filepath.Join(dir, "retry.jsonl"), 0, 0, 0, func([]Event) ([]Event, error) { return nil, nil })

	if q.maxBytes != 0 {
		t.Fatalf("maxBytes = %d with no configured cap, want 0 (unbounded)", q.maxBytes)
	}

	// ~2 MB of payload across 40 batches. Under the old 20 MB default this
	// stayed under the cap, so size the assertion on batch identity rather
	// than bytes: every batch enqueued must still be present.
	const batches = 40
	pad := strings.Repeat("x", 50_000)
	for i := 0; i < batches; i++ {
		q.enqueue([]Event{{Name: fmt.Sprintf("batch-%d", i), Payload: map[string]any{"pad": pad}}})
	}

	got := q.load()
	if len(got) != batches {
		t.Fatalf("got %d batches, want %d — an unbounded queue must not evict", len(got), batches)
	}
	if got[0].Events[0].Name != "batch-0" {
		t.Errorf("oldest batch = %q, want batch-0 — the earliest events of an outage were dropped", got[0].Events[0].Name)
	}
}

// TestRetryQueue_ExplicitCapStillDrops pins that the hard cap remains
// available to an operator who explicitly opts into it — the fix removes the
// unsafe default, not the capability.
func TestRetryQueue_ExplicitCapStillDrops(t *testing.T) {
	dir := t.TempDir()
	q := newRetryQueue("http", filepath.Join(dir, "retry.jsonl"), 1, 0, 0, func([]Event) ([]Event, error) { return nil, nil })

	if q.maxBytes != 1*1024*1024 {
		t.Fatalf("maxBytes = %d for an explicit 1 MB cap, want %d", q.maxBytes, 1*1024*1024)
	}

	pad := strings.Repeat("x", 200_000)
	for i := 0; i < 20; i++ {
		q.enqueue([]Event{{Name: fmt.Sprintf("batch-%d", i), Payload: map[string]any{"pad": pad}}})
	}

	got := q.load()
	if len(got) >= 20 {
		t.Fatalf("got %d batches under an explicit 1 MB cap, want fewer than 20 (cap must still evict)", len(got))
	}
	if got[len(got)-1].Events[0].Name != "batch-19" {
		t.Errorf("newest batch = %q, want batch-19 — eviction must drop oldest-first", got[len(got)-1].Events[0].Name)
	}
}
