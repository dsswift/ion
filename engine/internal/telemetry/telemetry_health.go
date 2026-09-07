package telemetry

import (
	"errors"
	"io/fs"
	"sync"
	"syscall"
	"time"
)

// telemetry_health.go surfaces the delivery health of a target's retry queue
// as observable state (issue #379, and the "telemetry on whether telemetry is
// flowing" requirement in Orion 0008).
//
// The engine's own logs already record every delivery failure, but a log line
// is a poor foundation for an operator alert: it requires someone to be
// tailing, and it carries no notion of "how bad is this now" versus "how bad
// was it a minute ago". A queue that is quietly growing during a multi-hour
// outage looks identical, line by line, to one that failed twice and
// recovered.
//
// So the queue reports structured state, and a host wires an observer to turn
// that into whatever its consumers need — a typed engine event, a desktop
// notification, an OTEL gauge. The telemetry package deliberately does not
// know which: it is a leaf package with no business importing the event bus,
// the same reason ConversationEmitter takes a BeforeEventFunc rather than
// calling hooks itself.
//
// Three things escalate, independently: backlog size (against the soft-warn
// threshold), backlog age (a queue whose oldest batch has waited past the
// stuck threshold, at any size), and quarantine (content that left the
// stream). The second exists because the first once stayed silent through
// 255 failed attempts on a batch that was small but undeliverable.

// warnFractions are the fractions of the soft-warning threshold that escalate
// the health signal. An operator watching a backlog wants to hear about it
// while it is still draining, not at the moment the disk fills, so the first
// crossing is deliberately early (half the advisory threshold).
var warnFractions = []int{50, 75, 85, 95}

// TelemetryHealth is one target's delivery state at a point in time.
//
// It is a snapshot, not a delta: every field describes the queue as it stands
// when the observation is made, so a consumer replaces its view rather than
// accumulating. This matches the engine's existing snapshot-event convention
// (see docs/architecture/agent-state.md) and means a consumer that missed an
// observation is never left with a stale partial picture.
type TelemetryHealth struct {
	// Target is the egress target this describes: "http" or "eventhub".
	Target string `json:"target"`

	// QueuedBatches, QueuedEvents, and QueuedBytes describe the backlog
	// awaiting redelivery. All three are zero on a healthy target.
	QueuedBatches int   `json:"queuedBatches"`
	QueuedEvents  int   `json:"queuedEvents"`
	QueuedBytes   int64 `json:"queuedBytes"`

	// OldestAgeMs is how long the oldest undelivered batch has been waiting.
	// Age matters independently of size: a small backlog that has not moved
	// in an hour is a different failure from a large one draining steadily.
	OldestAgeMs int64 `json:"oldestAgeMs"`

	// MaxAttempts is the highest redelivery attempt count of any queued
	// batch. Rising attempts with a flat OldestAgeMs distinguish "keeps
	// failing" from "waiting out one long backoff".
	MaxAttempts int `json:"maxAttempts,omitempty"`

	// Stuck is true when OldestAgeMs has reached StuckAfterMs: the queue
	// has not fully drained within the configured window. It is reported on
	// the transition in each direction and is independent of size, so a
	// backlog too small to cross a size notch still escalates once it is
	// old enough.
	Stuck        bool  `json:"stuck,omitempty"`
	StuckAfterMs int64 `json:"stuckAfterMs,omitempty"`

	// QuarantinedEvents and QuarantinedBytes count, cumulatively for the
	// process, the events written to the quarantine file instead of being
	// sent: content the transport could never carry under the configured
	// oversize policy. They are on disk, not in the stream, and every
	// increase is reported.
	QuarantinedEvents int   `json:"quarantinedEvents,omitempty"`
	QuarantinedBytes  int64 `json:"quarantinedBytes,omitempty"`

	// SoftWarnBytes is the advisory threshold the crossing percentages are
	// measured against, echoed so a consumer can render "180 MB of 500 MB"
	// without knowing the engine's configuration.
	SoftWarnBytes int64 `json:"softWarnBytes"`

	// PercentOfSoftWarn is QueuedBytes as a percentage of SoftWarnBytes. It
	// is not clamped: a queue past its advisory threshold reports above 100,
	// which is meaningful rather than an error, since the queue is unbounded
	// by default and legitimately keeps growing.
	PercentOfSoftWarn int `json:"percentOfSoftWarn"`

	// CrossedThreshold is the escalation step this observation represents
	// (50, 75, 85, or 95), or 0 when the observation is not a crossing.
	// Consumers that only want to alert on escalation filter on this.
	CrossedThreshold int `json:"crossedThreshold,omitempty"`

	// Healthy is false when the last delivery attempt failed. A target can
	// be unhealthy with an empty queue (the failure just happened) or
	// healthy with a non-empty one (draining a past outage).
	Healthy bool `json:"healthy"`

	// LastError is the most recent delivery error, empty when healthy.
	LastError string `json:"lastError,omitempty"`

	// Critical marks a condition the engine cannot resolve by retrying —
	// today, a queue write that failed because the disk is full. Durability
	// is genuinely lost at that point: events are neither delivered nor
	// persisted, so this is the one health condition that is an error rather
	// than a backlog report.
	Critical bool `json:"critical,omitempty"`
}

// HealthObserver receives a TelemetryHealth snapshot. A host installs one to
// project queue state onto its own surfaces; nil (the default) means the
// engine keeps its log-only behavior.
type HealthObserver func(TelemetryHealth)

// healthTracker holds the per-queue state needed to decide when an
// observation is worth reporting. Reporting every enqueue would drown a
// consumer during exactly the outage it needs to reason about, so crossings
// escalate upward and reset only once the queue actually drains, stuck is
// reported on each transition, and quarantine on each increase.
type healthTracker struct {
	mu              sync.Mutex
	observer        HealthObserver
	lastNotch       int
	lastStuck       bool
	lastQuarantined int
	lastReport      time.Time
}

// notchFor returns the highest warning fraction the given percentage has
// reached, or 0 below the first one.
func notchFor(percentOfSoftWarn int) int {
	notch := 0
	for _, f := range warnFractions {
		if percentOfSoftWarn >= f {
			notch = f
		}
	}
	return notch
}

// observe reports a health snapshot when it is worth reporting: a new
// escalation notch, a drop back to healthy after a backlog, a stuck
// transition in either direction, newly quarantined events, or a critical
// condition. Steady-state growth between notches stays silent.
func (t *healthTracker) observe(h TelemetryHealth) {
	if t == nil {
		return
	}
	t.mu.Lock()
	observer := t.observer
	notch := notchFor(h.PercentOfSoftWarn)
	crossed := notch > t.lastNotch
	recovered := notch == 0 && t.lastNotch > 0
	stuckChanged := h.Stuck != t.lastStuck
	quarantined := h.QuarantinedEvents > t.lastQuarantined
	report := h.Critical || crossed || recovered || stuckChanged || quarantined
	if report {
		if crossed {
			h.CrossedThreshold = notch
		}
		t.lastNotch = notch
		t.lastStuck = h.Stuck
		t.lastQuarantined = h.QuarantinedEvents
		t.lastReport = time.Now()
	}
	t.mu.Unlock()

	if report && observer != nil {
		observer(h)
	}
}

// isDiskFull reports whether an error is a no-space-left condition, the one
// queue-write failure the engine treats as critical rather than transient.
// Checked structurally rather than by string match so it holds across
// platforms and wrapped errors.
func isDiskFull(err error) bool {
	if err == nil {
		return false
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return errno == syscall.ENOSPC || errno == syscall.EDQUOT
	}
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		return isDiskFull(pathErr.Err)
	}
	return false
}

// SetHealthObserver installs fn as the receiver for every retry queue this
// Collector owns. A host calls this once after construction to project
// delivery health onto its own surfaces (a typed engine event, a client
// notification). Passing nil restores the default log-only behavior.
//
// Safe on a Collector with no network target: the queues are nil and the
// call is a no-op, so a caller need not first ask which targets exist.
func (c *Collector) SetHealthObserver(fn HealthObserver) {
	if c == nil {
		return
	}
	c.httpRetry.setHealthObserver(fn)
	c.eventHubRetry.setHealthObserver(fn)
}

// TelemetryHealthSnapshot reports the current delivery health of every
// configured target, for a caller that wants state on demand rather than on
// transition — a status command, or a client reconnecting mid-outage that
// needs the current picture rather than waiting for the next crossing.
func (c *Collector) TelemetryHealthSnapshot() []TelemetryHealth {
	if c == nil {
		return nil
	}
	var out []TelemetryHealth
	if c.httpRetry != nil {
		out = append(out, c.httpRetry.stats(true, ""))
	}
	if c.eventHubRetry != nil {
		out = append(out, c.eventHubRetry.stats(true, ""))
	}
	return out
}
