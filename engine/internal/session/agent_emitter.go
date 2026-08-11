package session

// agent_emitter.go — the dedup and coalesce gate for engine_agent_state.
//
// Two problems, one gate:
//
//  1. REPEATS. A wedged extension re-published a byte-identical roster 1,873
//     times over 15 hours. Every repeat was serialised, written to the socket,
//     forwarded over IPC, and applied by every consumer, for zero state change.
//
//  2. BURSTS. Routine activity produced bursts of 38 emissions in a single
//     second, each a complete snapshot of every agent.
//
// Why dropping emissions is safe: engine_agent_state is a complete snapshot,
// so emission N+1 is a total function of engine state and strictly supersedes
// N. A consumer receiving only N+1 lands in exactly the state it would occupy
// after applying N then N+1. docs/architecture/agent-state.md further forbids
// deriving history from these events, so no conforming consumer can tell the
// difference. Dedup is weaker still — re-sending identical bytes is a no-op.
//
// What the gate must never delay:
//
//   - Forced emissions. Heartbeat and reconcile re-assert an unchanged truth
//     to a client that may have missed it; there the repeat IS the signal.
//     Terminal transitions (abort, run exit, host death, rehydrate) carry
//     agent-state.md's guarantee that a run's end is promptly visible.
//   - Structural changes. Any change to the ordered (name, id, status) tuple
//     set — an agent appearing, disappearing, or reaching a terminal status —
//     flushes synchronously. Only metadata-only churn is ever held.
//
// The window is a LEADING+TRAILING rate limiter, not a plain trailing
// debounce. A trailing-only debounce would add the full window's latency to
// every isolated update, which is a real regression in perceived
// responsiveness. Here the first change in an idle window emits immediately
// and only a burst is collapsed.

import (
	"encoding/json"
	"hash/fnv"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// suppressedRepeatWarnThreshold is the count of consecutive suppressed
// identical snapshots that triggers a WARN.
//
// This is a diagnostic the incident wanted and did not have. The clamp bounds
// the SIZE of a wedged payload but does not explain why something rebuilt an
// unchanging roster 1,873 times; without this, that condition is invisible
// until someone notices the CPU. With it, "this session is rebuilding the
// world for no reason" is one greppable line.
const suppressedRepeatWarnThreshold = 100

// agentEmitter holds the per-session gate state.
//
// It carries its own mutex rather than reusing Manager.mu: the trailing-flush
// timer fires on its own goroutine and calls back into the emit path, which
// takes m.mu.RLock, so sharing the lock would invite an inversion.
type agentEmitter struct {
	mu     sync.Mutex
	timer  *time.Timer
	closed bool

	// windowOpen marks that an emission happened recently, so the next change
	// is absorbed rather than emitted on the leading edge.
	windowOpen bool
	// pending marks that a change arrived during the window and still needs a
	// trailing flush.
	pending       bool
	pendingReason string
	pendingCount  int

	lastHash      uint64
	lastStatusKey string
	hasLast       bool

	suppressedCount int
	suppressedSince time.Time
}

// emitDecision is what the gate returns to the funnel.
type emitDecision int

const (
	emitNow      emitDecision = iota // send immediately
	emitSuppress                     // identical to the last send; drop it
	emitDefer                        // absorbed into the open window
)

// decide applies the gate. Callers must not hold Manager.mu.
//
// flush is a callback the emitter invokes on the trailing edge; it must
// re-read the current snapshot rather than closing over this one, or the
// coalesced emission would carry stale state and the losslessness argument
// would not hold.
func (e *agentEmitter) decide(
	snapshot []types.AgentStateUpdate,
	reason string,
	force bool,
	limits types.ResolvedAgentStateEmitLimits,
	flush func(reason string, coalesced int),
) emitDecision {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.closed {
		return emitSuppress
	}

	statusKey := structuralKey(snapshot)
	hash := snapshotHash(snapshot)

	// 1. Forced emissions bypass every gate.
	if force {
		e.cancelTimerLocked()
		e.recordSentLocked(hash, statusKey)
		e.openWindowLocked(limits, flush)
		return emitNow
	}

	// 2. A structural change (agent added, removed, or status transitioned)
	//    is never delayed: this is the class agent-state.md requires to be
	//    promptly visible, and the class a user perceives as responsiveness.
	if !e.hasLast || statusKey != e.lastStatusKey {
		e.cancelTimerLocked()
		e.recordSentLocked(hash, statusKey)
		e.openWindowLocked(limits, flush)
		return emitNow
	}

	// 3. Byte-identical to what we last sent: a no-op under snapshot
	//    semantics.
	if limits.Dedup && e.hasLast && hash == e.lastHash {
		e.suppressedCount++
		if e.suppressedSince.IsZero() {
			e.suppressedSince = time.Now()
		}
		if e.suppressedCount == suppressedRepeatWarnThreshold {
			utils.LogWithFields(utils.LevelWarn, "session", "agent_state: session is re-emitting an unchanged snapshot repeatedly", map[string]any{
				"suppressed": e.suppressedCount, "reason": reason,
				"window_seconds": time.Since(e.suppressedSince).Seconds(),
			})
		}
		return emitSuppress
	}

	// 4. Metadata-only change. Leading edge emits immediately; a change inside
	//    an already-open window is absorbed and flushed at the trailing edge.
	if limits.CoalesceMs < 0 {
		e.recordSentLocked(hash, statusKey)
		return emitNow
	}

	if !e.windowOpen {
		e.recordSentLocked(hash, statusKey)
		e.openWindowLocked(limits, flush)
		return emitNow
	}

	e.pending = true
	e.pendingReason = reason
	e.pendingCount++
	return emitDefer
}

// openWindowLocked starts the rate-limit window after an emission.
//
// Every emit path calls this, not just the metadata one. The window means
// "something just went out, so absorb immediate follow-up churn" — and a
// structural change is exactly what tends to be followed by a burst of
// metadata updates (an agent starts, then streams progress). Opening the
// window only on the metadata path let two consecutive changes both emit
// immediately, which defeated the rate limit for the most common sequence.
//
// Caller holds e.mu.
func (e *agentEmitter) openWindowLocked(limits types.ResolvedAgentStateEmitLimits, flush func(string, int)) {
	if limits.CoalesceMs < 0 {
		return // coalescing disabled
	}
	e.windowOpen = true
	d := time.Duration(limits.CoalesceMs) * time.Millisecond
	e.timer = time.AfterFunc(d, func() {
		e.mu.Lock()
		if e.closed {
			e.mu.Unlock()
			return
		}
		e.timer = nil
		e.windowOpen = false
		pending, reason, count := e.pending, e.pendingReason, e.pendingCount
		e.pending, e.pendingReason, e.pendingCount = false, "", 0
		e.mu.Unlock()

		if pending {
			// The callback re-reads the CURRENT snapshot. Holding the one from
			// when the window opened would emit stale state and break the
			// losslessness this gate depends on.
			flush(reason+"_coalesced", count)
		}
	})
}

func (e *agentEmitter) cancelTimerLocked() {
	if e.timer != nil {
		e.timer.Stop()
		e.timer = nil
	}
	e.windowOpen = false
	e.pending = false
	e.pendingReason = ""
	e.pendingCount = 0
}

func (e *agentEmitter) recordSentLocked(hash uint64, statusKey string) {
	if e.suppressedCount > 0 {
		utils.LogWithFields(utils.LevelDebug, "session", "agent_state: resumed after suppressed repeats", map[string]any{
			"suppressed": e.suppressedCount,
		})
	}
	e.lastHash = hash
	e.lastStatusKey = statusKey
	e.hasLast = true
	e.suppressedCount = 0
	e.suppressedSince = time.Time{}
}

// stop halts the timer and blocks further emissions.
//
// It deliberately does NOT flush a pending change. Session teardown always
// force-emits its own terminal snapshot, so flushing here would race that with
// a staler view.
func (e *agentEmitter) stop() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.pending {
		utils.LogWithFields(utils.LevelInfo, "session", "agent_state: dropping pending coalesced emission at session stop", map[string]any{
			"pending_count": e.pendingCount, "reason": e.pendingReason,
		})
	}
	e.cancelTimerLocked()
	e.closed = true
}

// structuralKey renders the (name, id, status) tuple set, which is what
// "structural change" means: an agent appearing, disappearing, or changing
// status. Metadata is deliberately excluded — it is the churn being damped.
func structuralKey(snapshot []types.AgentStateUpdate) string {
	var b strings.Builder
	for i := range snapshot {
		b.WriteString(snapshot[i].Name)
		b.WriteByte(0)
		b.WriteString(snapshot[i].ID)
		b.WriteByte(0)
		b.WriteString(snapshot[i].Status)
		b.WriteByte(1)
	}
	return b.String()
}

// snapshotHash fingerprints the full snapshot including metadata.
//
// encoding/json sorts map keys, so marshalling a map[string]interface{} is
// deterministic for identical content. That property is load-bearing: without
// it two equal snapshots could hash differently and dedup would never fire.
//
// A hash rather than reflect.DeepEqual, and a hash rather than retaining the
// previous snapshot: storing the last payload to compare against would double
// the memory footprint of exactly the oversized-payload pathology this whole
// change exists to remove.
func snapshotHash(snapshot []types.AgentStateUpdate) uint64 {
	h := fnv.New64a()
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		// Marshal failure means the payload is not serialisable, so it could
		// not have been sent either. Fall back to a length-derived value so
		// dedup degrades to "assume changed" rather than silently collapsing
		// distinct snapshots onto one hash.
		utils.LogWithFields(utils.LevelWarn, "session", "agent_state: snapshot hash fell back, marshal failed", map[string]any{
			"error": err.Error(), "count": len(snapshot),
		})
		_, _ = h.Write([]byte(strconv.FormatInt(time.Now().UnixNano(), 10))) //nolint:errcheck // hash.Write never errors
		return h.Sum64()
	}
	_, _ = h.Write(encoded) //nolint:errcheck // hash.Write never errors
	return h.Sum64()
}
