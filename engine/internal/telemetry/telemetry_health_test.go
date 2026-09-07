package telemetry

import (
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
)

// newHealthTestQueue builds a queue with a small soft-warn threshold so a
// test can cross escalation notches without writing megabytes.
func newHealthTestQueue(t *testing.T, softWarnBytes int64) (*retryQueue, *[]TelemetryHealth, *sync.Mutex) {
	t.Helper()
	dir := t.TempDir()
	q := newRetryQueue("eventhub", filepath.Join(dir, "retry.jsonl"), 0, 0, 0, func([]Event) ([]Event, error) { return nil, nil })
	q.softWarnBytes = softWarnBytes

	var mu sync.Mutex
	var seen []TelemetryHealth
	q.setHealthObserver(func(h TelemetryHealth) {
		mu.Lock()
		seen = append(seen, h)
		mu.Unlock()
	})
	return q, &seen, &mu
}

func enqueuePadded(q *retryQueue, name string, padBytes int) {
	q.enqueue([]Event{{Name: name, Payload: map[string]any{"pad": strings.Repeat("x", padBytes)}}})
}

// TestHealth_EscalatesThroughNotchesOnce pins the escalation contract: an
// operator hears about a growing backlog at each threshold and not on every
// enqueue, because a report per enqueue would drown them during exactly the
// outage they need to reason about.
func TestHealth_EscalatesThroughNotchesOnce(t *testing.T) {
	q, seen, mu := newHealthTestQueue(t, 10_000)

	for i := 0; i < 12; i++ {
		enqueuePadded(q, fmt.Sprintf("b%d", i), 800)
		q.reportHealth(false, "downstream unreachable")
	}

	mu.Lock()
	defer mu.Unlock()
	var crossings []int
	for _, h := range *seen {
		if h.CrossedThreshold != 0 {
			crossings = append(crossings, h.CrossedThreshold)
		}
	}
	if len(crossings) == 0 {
		t.Fatal("no threshold crossings reported while the queue grew past its soft warning")
	}
	for i := 1; i < len(crossings); i++ {
		if crossings[i] <= crossings[i-1] {
			t.Errorf("crossings not monotonically escalating: %v", crossings)
			break
		}
	}
	for _, c := range crossings {
		if c != 50 && c != 75 && c != 85 && c != 95 {
			t.Errorf("crossing %d is not one of the 50/75/85/95 notches (%v)", c, crossings)
		}
	}
}

// TestHealth_ReportsRecovery pins that a consumer sees the queue drain, not
// only that it filled. Recovery is the transition an operator watching an
// outage is actually waiting for.
func TestHealth_ReportsRecovery(t *testing.T) {
	q, seen, mu := newHealthTestQueue(t, 4_000)

	for i := 0; i < 8; i++ {
		enqueuePadded(q, fmt.Sprintf("b%d", i), 800)
	}
	q.reportHealth(false, "downstream unreachable")

	// Drain, then report healthy.
	q.save(nil)
	q.reportHealth(true, "")

	mu.Lock()
	defer mu.Unlock()
	if len(*seen) < 2 {
		t.Fatalf("got %d observations, want at least a rise and a recovery", len(*seen))
	}
	last := (*seen)[len(*seen)-1]
	if !last.Healthy {
		t.Errorf("final observation Healthy = false, want true after the queue drained")
	}
	if last.QueuedEvents != 0 || last.QueuedBatches != 0 {
		t.Errorf("final observation still reports a backlog: %+v", last)
	}
}

// TestHealth_SnapshotCountsBacklog pins the numbers a consumer renders.
func TestHealth_SnapshotCountsBacklog(t *testing.T) {
	q, _, _ := newHealthTestQueue(t, 100_000)

	enqueuePadded(q, "one", 500)
	q.enqueue([]Event{{Name: "two"}, {Name: "three"}})

	h := q.stats(false, "boom")
	if h.Target != "eventhub" {
		t.Errorf("Target = %q, want eventhub", h.Target)
	}
	if h.QueuedBatches != 2 {
		t.Errorf("QueuedBatches = %d, want 2", h.QueuedBatches)
	}
	if h.QueuedEvents != 3 {
		t.Errorf("QueuedEvents = %d, want 3", h.QueuedEvents)
	}
	if h.QueuedBytes <= 0 {
		t.Errorf("QueuedBytes = %d, want > 0", h.QueuedBytes)
	}
	if h.Healthy {
		t.Error("Healthy = true after a failed delivery")
	}
	if h.LastError != "boom" {
		t.Errorf("LastError = %q, want boom", h.LastError)
	}
}

// TestHealth_PercentUnclampedPastThreshold pins that an unbounded queue past
// its advisory threshold reports above 100 rather than saturating. The queue
// legitimately keeps growing; a clamped number would hide how far past the
// operator actually is.
func TestHealth_PercentUnclampedPastThreshold(t *testing.T) {
	q, _, _ := newHealthTestQueue(t, 1_000)
	for i := 0; i < 10; i++ {
		enqueuePadded(q, fmt.Sprintf("b%d", i), 500)
	}
	h := q.stats(false, "still down")
	if h.PercentOfSoftWarn <= 100 {
		t.Errorf("PercentOfSoftWarn = %d, want > 100 for a queue past its soft threshold", h.PercentOfSoftWarn)
	}
}

// TestHealth_DiskFullClassification pins the one condition treated as
// critical rather than a transient backlog. Checked structurally so it holds
// for wrapped and platform-specific errors, not by string match.
func TestHealth_DiskFullClassification(t *testing.T) {
	if isDiskFull(nil) {
		t.Error("nil error classified as disk-full")
	}
	if isDiskFull(fmt.Errorf("connection refused")) {
		t.Error("an ordinary error classified as disk-full")
	}
	wrapped := fmt.Errorf("retry queue write failed: %w", &pathErrorStub{})
	if !isDiskFull(wrapped) {
		t.Error("a wrapped ENOSPC was not classified as disk-full; a full disk would be reported as an ordinary backlog")
	}
}

// pathErrorStub reproduces the shape the os layer returns on a full disk.
type pathErrorStub struct{}

func (p *pathErrorStub) Error() string { return "write: no space left on device" }
func (p *pathErrorStub) Unwrap() error {
	return &fs.PathError{Op: "write", Path: "/x", Err: syscall.ENOSPC}
}
