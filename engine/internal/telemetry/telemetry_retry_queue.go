package telemetry

import (
	"crypto/sha1" //nolint:gosec // used only to derive a stable filename, not for security
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/durablefile"
	"github.com/dsswift/ion/engine/internal/utils"
)

// telemetry_retry_queue.go gives every network-based target durable
// delivery through one shared retry/backoff mechanism. Before this existed
// (as the "http"-only telemetry_http_retry.go), Collector.Flush cleared its
// buffer unconditionally and then attempted delivery — a failed send
// silently dropped the batch, contradicting docs/enterprise/telemetry.md's
// claim of retry-with-backoff. The "eventhub" target (issue #378) reuses
// this identical mechanism rather than growing its own copy: same
// enqueue/backoff semantics, parameterized only by a deliverFunc and a
// queue file path.
//
// The queue is UNBOUNDED by default, deliberately (issue #379). This
// carries an audit stream: an operator enables conversation events because
// a regulator, a security review, or an AI-usage policy requires knowing
// what was said, and a dropped batch is a hole in that record precisely
// when the downstream was unreachable — the moment most likely to matter.
// An earlier revision defaulted to a 20 MB cap with drop-oldest, which
// silently discarded the oldest conversations of an outage while reporting
// success. A hard cap is still available, but it is now an explicit opt-in
// (MaxMB > 0) so the data loss it causes is always a choice someone made
// rather than a default they inherited.
//
// Growth is instead made visible: softWarnBytes drives the escalating
// backlog signal (see queueStats and the telemetry-health event) so an
// operator sees a queue growing long before a disk fills, and a write that
// genuinely cannot proceed fails loudly rather than pretending.
//
// The queue never retries forever. A deliverFunc may hand back fewer events
// than it was given (it quarantined the ones the transport can never carry —
// see telemetry_oversize.go), and a batch whose oldest entry has waited past
// stuckAfter is reported as stuck regardless of its size, because a small
// backlog that has not moved in an hour is the failure an operator most
// needs to hear about and the one a size-only signal never raises.

const (
	// defaultRetryQueueSoftWarnMB is the advisory backlog threshold. It
	// never drops anything; crossing fractions of it escalates the
	// telemetry-health signal so an operator can act while the queue is
	// still draining normally.
	defaultRetryQueueSoftWarnMB = 500
	// defaultRetryQueueStuckAfter is how long the oldest undelivered batch
	// may wait before the queue is reported stuck. Long enough to ride out a
	// transient outage without paging anyone; short enough that a batch
	// failing every backoff cycle is noticed the same hour, not the next day.
	defaultRetryQueueStuckAfter = 15 * time.Minute
	retryBaseBackoff            = 5 * time.Second
	retryMaxBackoff             = 5 * time.Minute
)

// deliverFunc attempts one delivery of a batch of events. Each target
// supplies its own (deliverToHTTP for "http", Collector.deliverToEventHub
// for "eventhub") so the retry mechanism itself stays transport-agnostic.
// On failure it returns the events still owed — which may be fewer than it
// was given, or in a different (fitted) form, when the target disposed of
// some another way — and the queue persists exactly that. On success it
// returns nil. An error with no remaining events means every event was
// accounted for (delivered or quarantined) and the batch is done.
type deliverFunc func(events []Event) (remaining []Event, err error)

// queuedBatch is one on-disk retry entry: the events that failed to
// deliver, plus enough state to back off correctly on the next attempt.
// EnqueuedAt is the first failure's time, so a batch's age is exact rather
// than derived from its next retry; entries written before the field
// existed derive it from NextRetryAt on load.
type queuedBatch struct {
	Events      []Event `json:"events"`
	NextRetryAt int64   `json:"next_retry_at_ms"`
	Attempt     int     `json:"attempt"`
	EnqueuedAt  int64   `json:"enqueued_at_ms,omitempty"`
}

// retryQueue persists undelivered target batches to disk (one file per
// Collector target instance) and redelivers them FIFO with exponential
// backoff on each flush tick, ahead of newly-buffered events.
//
// maxBytes of 0 means unbounded — the default, see the file doc comment.
// When an operator sets an explicit cap, entries beyond it are dropped
// oldest-first with a logged WARN, never silently.
type retryQueue struct {
	mu            sync.Mutex
	path          string
	target        string
	deliver       deliverFunc
	maxBytes      int64
	softWarnBytes int64
	stuckAfter    time.Duration
	health        *healthTracker
	quarantine    *quarantine
}

// newRetryQueue builds the retry queue for one Collector target. path is
// derived once by retryQueuePath and never changes for the lifetime of the
// Collector.
//
// maxMB <= 0 selects the unbounded default. A positive value is the
// operator's explicit opt-in to a hard cap, and to the data loss that cap
// causes during a long outage. softWarnMB <= 0 selects
// defaultRetryQueueSoftWarnMB; stuckAfterMin <= 0 selects
// defaultRetryQueueStuckAfter.
func newRetryQueue(target, path string, maxMB, softWarnMB, stuckAfterMin int, deliver deliverFunc) *retryQueue {
	if softWarnMB <= 0 {
		softWarnMB = defaultRetryQueueSoftWarnMB
	}
	stuckAfter := defaultRetryQueueStuckAfter
	if stuckAfterMin > 0 {
		stuckAfter = time.Duration(stuckAfterMin) * time.Minute
	}
	q := &retryQueue{
		path:          path,
		target:        target,
		deliver:       deliver,
		softWarnBytes: int64(softWarnMB) * 1024 * 1024,
		stuckAfter:    stuckAfter,
		health:        &healthTracker{},
		quarantine:    newQuarantine(path, target),
	}
	if maxMB > 0 {
		q.maxBytes = int64(maxMB) * 1024 * 1024
		utils.LogWithFields(utils.LevelWarn, "telemetry", "retry queue configured with an explicit hard cap; batches beyond it will be dropped oldest-first during a sustained outage", map[string]any{
			"path": path, "max_bytes": q.maxBytes,
		})
	}
	utils.LogWithFields(utils.LevelInfo, "telemetry", "retry queue ready", map[string]any{
		"path": path, "target": target, "soft_warn_bytes": q.softWarnBytes,
		"stuck_after_ms": stuckAfter.Milliseconds(), "quarantine_path": q.quarantine.path,
	})
	return q
}

// retryQueuePath derives a stable, collision-free path for one collector
// target's retry queue. kind ("http", "eventhub", ...) keeps two targets on
// the same collector from colliding on one queue file. Preferring a path
// alongside the configured file target keeps related files together on
// disk; falling back to a hash of discriminant (the endpoint, or the
// connection string + hub name) covers the case where no file target is
// configured at all, without two distinct collectors of the same kind
// colliding.
func retryQueuePath(kind, filePath, discriminant string) string {
	if filePath != "" {
		return utils.ExpandHomePath(filePath) + "." + kind + "-retry.jsonl"
	}
	sum := sha1.Sum([]byte(discriminant)) //nolint:gosec // filename derivation only
	return utils.ExpandHomePath(fmt.Sprintf("~/.ion/%s-retry-%x.jsonl", kind, sum[:8]))
}

// load reads the persisted queue. A missing file is an empty queue, not an
// error — the common case before any delivery attempt has ever failed.
func (q *retryQueue) load() []queuedBatch {
	data, err := os.ReadFile(q.path)
	if err != nil {
		return nil
	}
	var batches []queuedBatch
	if err := json.Unmarshal(data, &batches); err != nil {
		utils.LogWithFields(utils.LevelWarn, "telemetry", "retry queue corrupt discarding", map[string]any{"path": q.path, "error": err.Error()})
		return nil
	}
	for i := range batches {
		if batches[i].EnqueuedAt == 0 {
			// Written before EnqueuedAt existed: the first retry is scheduled
			// one base backoff after enqueue, which recovers it exactly.
			batches[i].EnqueuedAt = batches[i].NextRetryAt - retryBaseBackoff.Milliseconds()
		}
	}
	return batches
}

// save persists the queue atomically (write-then-rename via durablefile),
// the same crash-safe pattern schema.go's sidecar already uses. An empty
// slice removes the file rather than writing an empty JSON array, so a
// fully-drained queue leaves no trace on disk.
func (q *retryQueue) save(batches []queuedBatch) {
	if len(batches) == 0 {
		if err := os.Remove(q.path); err != nil && !os.IsNotExist(err) {
			utils.LogWithFields(utils.LevelInfo, "telemetry", "retry queue remove failed", map[string]any{"path": q.path, "error": err.Error()})
		}
		return
	}
	data, err := json.Marshal(batches)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "telemetry", "retry queue marshal failed", map[string]any{"path": q.path, "error": err.Error()})
		return
	}
	if err := durablefile.Write(q.path, data, 0o644); err != nil {
		critical := isDiskFull(err)
		level := utils.LevelError
		utils.LogWithFields(level, "telemetry", "retry queue write failed", map[string]any{
			"path": q.path, "target": q.target, "error": err.Error(),
			"critical": critical, "undelivered_batches": len(batches),
		})
		// A disk-full write is the one failure retrying cannot resolve: the
		// batch is neither delivered nor persisted, so durability is lost
		// right now rather than deferred. Fail loudly to the observer so an
		// operator hears it, instead of leaving an audit hole that only
		// surfaces when someone later queries for events that were never
		// written anywhere.
		if critical {
			q.health.observe(q.statsLocked(batches, false, err.Error(), true))
		}
	}
}

// enqueue appends a failed batch and enforces maxBytes, dropping the
// oldest entries first when over the cap. Called from Collector.Flush's
// target cases immediately after a delivery attempt fails.
func (q *retryQueue) enqueue(events []Event) {
	q.mu.Lock()
	defer q.mu.Unlock()

	now := time.Now()
	batches := q.load()
	batches = append(batches, queuedBatch{
		Events:      events,
		NextRetryAt: now.Add(retryBaseBackoff).UnixMilli(),
		Attempt:     0,
		EnqueuedAt:  now.UnixMilli(),
	})

	// Unbounded (maxBytes == 0) is the default and never drops. A hard cap
	// only trims when the operator explicitly asked for one.
	if q.maxBytes > 0 {
		for {
			data, err := json.Marshal(batches)
			if err != nil || int64(len(data)) <= q.maxBytes || len(batches) <= 1 {
				break
			}
			dropped := batches[0]
			batches = batches[1:]
			utils.LogWithFields(utils.LevelWarn, "telemetry", "retry queue over cap dropping oldest batch", map[string]any{
				"path": q.path, "dropped_events": len(dropped.Events), "max_bytes": q.maxBytes,
			})
		}
	}
	q.save(batches)
}

// drainAndRetry redelivers every batch whose backoff has elapsed, called
// from flushLoop on every tick before the newly-buffered flush. Batches
// still waiting out their backoff are left in place; a batch that fails
// again has its attempt count incremented and its backoff doubled (capped
// at retryMaxBackoff) before being written back — in the form the target
// handed back, so a batch shrinks as its undeliverable members are
// quarantined and never re-quarantines them. Health is reported after the
// pass so a batch that has aged past stuckAfter is noticed on the tick it
// happens, not on the next fresh flush.
func (q *retryQueue) drainAndRetry() {
	q.mu.Lock()
	batches := q.load()
	q.mu.Unlock()
	if len(batches) == 0 {
		return
	}

	now := time.Now().UnixMilli()
	var remaining []queuedBatch
	delivered, failed := 0, 0
	lastErr := ""
	for _, b := range batches {
		if b.NextRetryAt > now {
			remaining = append(remaining, b)
			continue
		}
		owed, err := q.deliver(b.Events)
		if err == nil {
			delivered++
			continue
		}
		if len(owed) == 0 {
			// Every event was accounted for another way (quarantined); the
			// batch is finished even though the attempt reported an error.
			utils.LogWithFields(utils.LevelWarn, "telemetry", "retry queue batch fully disposed without delivery", map[string]any{
				"path": q.path, "attempt": b.Attempt, "events": len(b.Events), "error": err.Error(),
			})
			delivered++
			continue
		}
		failed++
		lastErr = err.Error()
		b.Events = owed
		b.Attempt++
		backoff := retryBaseBackoff * time.Duration(1<<uint(minInt(b.Attempt, 10)))
		if backoff > retryMaxBackoff {
			backoff = retryMaxBackoff
		}
		b.NextRetryAt = time.Now().Add(backoff).UnixMilli()
		utils.LogWithFields(utils.LevelWarn, "telemetry", "retry queue redelivery failed rescheduling", map[string]any{
			"path": q.path, "attempt": b.Attempt, "events": len(b.Events), "next_retry_in_s": backoff.Seconds(),
			"age_ms": now - b.EnqueuedAt, "error": err.Error(),
		})
		remaining = append(remaining, b)
	}
	if delivered > 0 {
		utils.LogWithFields(utils.LevelInfo, "telemetry", "retry queue redelivered batches", map[string]any{
			"path": q.path, "batches": delivered,
		})
	}

	q.mu.Lock()
	q.save(remaining)
	q.mu.Unlock()
	q.health.observe(q.statsLocked(remaining, failed == 0, lastErr, false))
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// quarantineEvents writes rejected events to this queue's quarantine file
// and reports the resulting health so a consumer hears that content left
// the stream. Called by the target's deliverFunc, never by the queue itself.
func (q *retryQueue) quarantineEvents(rejected []rejectedEvent) {
	if q == nil || len(rejected) == 0 {
		return
	}
	if q.quarantine.add(rejected) > 0 {
		q.health.observe(q.stats(true, ""))
	}
}

// stats builds a health snapshot for this queue's current on-disk state.
func (q *retryQueue) stats(healthy bool, lastErr string) TelemetryHealth {
	q.mu.Lock()
	batches := q.load()
	q.mu.Unlock()
	return q.statsLocked(batches, healthy, lastErr, false)
}

// statsLocked builds the snapshot from an already-loaded batch slice, for
// callers that hold the batches (and the lock) already.
func (q *retryQueue) statsLocked(batches []queuedBatch, healthy bool, lastErr string, critical bool) TelemetryHealth {
	h := TelemetryHealth{
		Target:        q.target,
		QueuedBatches: len(batches),
		SoftWarnBytes: q.softWarnBytes,
		StuckAfterMs:  q.stuckAfter.Milliseconds(),
		Healthy:       healthy,
		LastError:     lastErr,
		Critical:      critical,
	}
	oldest := int64(0)
	now := time.Now().UnixMilli()
	for _, b := range batches {
		h.QueuedEvents += len(b.Events)
		if age := now - b.EnqueuedAt; age > oldest {
			oldest = age
		}
		if b.Attempt > h.MaxAttempts {
			h.MaxAttempts = b.Attempt
		}
	}
	h.OldestAgeMs = oldest
	h.Stuck = oldest >= q.stuckAfter.Milliseconds()
	if data, err := json.Marshal(batches); err == nil {
		h.QueuedBytes = int64(len(data))
	}
	if q.softWarnBytes > 0 {
		h.PercentOfSoftWarn = int(h.QueuedBytes * 100 / q.softWarnBytes)
	}
	h.QuarantinedEvents, h.QuarantinedBytes = q.quarantine.counts()
	return h
}

// setHealthObserver installs the observer this queue reports snapshots to.
func (q *retryQueue) setHealthObserver(fn HealthObserver) {
	if q == nil || q.health == nil {
		return
	}
	q.health.mu.Lock()
	q.health.observer = fn
	q.health.mu.Unlock()
}

// reportHealth observes the queue's current state after a delivery attempt.
func (q *retryQueue) reportHealth(healthy bool, lastErr string) {
	if q == nil {
		return
	}
	q.health.observe(q.stats(healthy, lastErr))
}
