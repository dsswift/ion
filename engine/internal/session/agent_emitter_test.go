package session

import (
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func agent(name, id, status string, meta map[string]any) types.AgentStateUpdate {
	return types.AgentStateUpdate{Name: name, ID: id, Status: status, Metadata: meta}
}

func noFlush(string, int) {}

func testLimits() types.ResolvedAgentStateEmitLimits {
	return types.AgentStateEmitDefaults()
}

// A byte-identical repeat is a no-op under complete-snapshot semantics: the
// consumer replaces its view with a payload it already holds. In production a
// wedged extension re-published one unchanged roster 1,873 times.
func TestAgentEmitter_SuppressesIdenticalRepeat(t *testing.T) {
	e := &agentEmitter{}
	snap := []types.AgentStateUpdate{agent("a", "1", "running", map[string]any{"lastWork": "x"})}

	if got := e.decide(snap, "ext_emit_merged", false, testLimits(), noFlush); got != emitNow {
		t.Fatalf("first emission = %v, want emitNow", got)
	}
	if got := e.decide(snap, "ext_emit_merged", false, testLimits(), noFlush); got != emitSuppress {
		t.Errorf("identical repeat = %v, want emitSuppress", got)
	}
}

func TestAgentEmitter_DedupDisabledByConfig(t *testing.T) {
	e := &agentEmitter{}
	snap := []types.AgentStateUpdate{agent("a", "1", "running", nil)}
	limits := testLimits()
	limits.Dedup = false
	limits.CoalesceMs = -1

	e.decide(snap, "r", false, limits, noFlush)
	if got := e.decide(snap, "r", false, limits, noFlush); got != emitNow {
		t.Errorf("with dedup off, repeat = %v, want emitNow", got)
	}
}

// The leading edge is what keeps an isolated update instant. A plain trailing
// debounce would add the full window's latency to every single change.
func TestAgentEmitter_LeadingEdgeIsImmediate(t *testing.T) {
	e := &agentEmitter{}
	snap := []types.AgentStateUpdate{agent("a", "1", "running", map[string]any{"n": 1})}

	if got := e.decide(snap, "r", false, testLimits(), noFlush); got != emitNow {
		t.Errorf("first metadata change = %v, want emitNow (leading edge)", got)
	}
}

// A burst of metadata-only churn collapses: one leading emission plus one
// trailing flush, not 40 frames.
func TestAgentEmitter_CoalescesMetadataOnlyBurst(t *testing.T) {
	e := &agentEmitter{}
	limits := testLimits()
	limits.CoalesceMs = 40

	var mu sync.Mutex
	flushes := 0
	flush := func(string, int) { mu.Lock(); flushes++; mu.Unlock() }

	immediate := 0
	for i := 0; i < 40; i++ {
		snap := []types.AgentStateUpdate{agent("a", "1", "running", map[string]any{"elapsed": i})}
		if e.decide(snap, "r", false, limits, flush) == emitNow {
			immediate++
		}
	}

	if immediate != 1 {
		t.Errorf("immediate emissions = %d, want 1 (leading edge only)", immediate)
	}

	time.Sleep(120 * time.Millisecond)
	mu.Lock()
	got := flushes
	mu.Unlock()
	if got != 1 {
		t.Errorf("trailing flushes = %d, want 1", got)
	}
}

// Structural changes are the class agent-state.md requires to arrive promptly:
// an agent appearing, disappearing, or reaching a terminal status. This is a
// regression lock rather than a red-on-revert test -- before the gate existed
// every emission was immediate, so it could not have failed.
func TestAgentEmitter_StatusChangeFlushesImmediately(t *testing.T) {
	e := &agentEmitter{}
	limits := testLimits()
	limits.CoalesceMs = 10_000 // long enough that a delay would be obvious

	running := []types.AgentStateUpdate{agent("a", "1", "running", map[string]any{"n": 1})}
	e.decide(running, "r", false, limits, noFlush)

	// Metadata-only change while the window is open: absorbed.
	churn := []types.AgentStateUpdate{agent("a", "1", "running", map[string]any{"n": 2})}
	if got := e.decide(churn, "r", false, limits, noFlush); got != emitDefer {
		t.Fatalf("metadata churn inside window = %v, want emitDefer", got)
	}

	// Terminal status: must not wait for the window.
	done := []types.AgentStateUpdate{agent("a", "1", "done", map[string]any{"n": 2})}
	if got := e.decide(done, "r", false, limits, noFlush); got != emitNow {
		t.Errorf("terminal status transition = %v, want emitNow", got)
	}
}

func TestAgentEmitter_NewAgentFlushesImmediately(t *testing.T) {
	e := &agentEmitter{}
	limits := testLimits()
	limits.CoalesceMs = 10_000

	e.decide([]types.AgentStateUpdate{agent("a", "1", "running", nil)}, "r", false, limits, noFlush)

	two := []types.AgentStateUpdate{
		agent("a", "1", "running", nil),
		agent("b", "2", "running", nil),
	}
	if got := e.decide(two, "r", false, limits, noFlush); got != emitNow {
		t.Errorf("new agent appearing = %v, want emitNow", got)
	}
}

// Forced emissions are liveness (heartbeat, reconcile) and terminal
// transitions. For liveness the repeat IS the signal, so an unchanged
// snapshot must still go out -- this is what keeps a reconnecting client from
// rendering stale rows forever.
func TestAgentEmitter_ForceBypassesEveryGate(t *testing.T) {
	e := &agentEmitter{}
	snap := []types.AgentStateUpdate{agent("a", "1", "running", nil)}

	e.decide(snap, "ext_emit_merged", false, testLimits(), noFlush)
	for i := 0; i < 3; i++ {
		if got := e.decide(snap, "heartbeat", true, testLimits(), noFlush); got != emitNow {
			t.Errorf("forced emission %d = %v, want emitNow", i, got)
		}
	}
}

// The empty snapshot is the authoritative "wipe your view" signal, and
// reconcile sends it repeatedly on purpose.
func TestAgentEmitter_ForcedEmptySnapshotAlwaysEmits(t *testing.T) {
	e := &agentEmitter{}
	for i := 0; i < 2; i++ {
		if got := e.decide(nil, "reconcile", true, testLimits(), noFlush); got != emitNow {
			t.Errorf("forced empty snapshot %d = %v, want emitNow", i, got)
		}
	}
}

// coalesceMs: -1 is the escape hatch for a consumer that depends on emission
// cardinality. It must reproduce pre-gate behavior exactly.
func TestAgentEmitter_CoalesceDisabledRestoresImmediateCardinality(t *testing.T) {
	e := &agentEmitter{}
	limits := testLimits()
	limits.CoalesceMs = -1

	for i := 0; i < 10; i++ {
		snap := []types.AgentStateUpdate{agent("a", "1", "running", map[string]any{"n": i})}
		if got := e.decide(snap, "r", false, limits, noFlush); got != emitNow {
			t.Errorf("emission %d = %v, want emitNow with coalescing disabled", i, got)
		}
	}
}

func TestAgentEmitter_StopPreventsFurtherEmissions(t *testing.T) {
	e := &agentEmitter{}
	e.stop()
	if got := e.decide(nil, "r", true, testLimits(), noFlush); got != emitSuppress {
		t.Errorf("after stop, decide = %v, want emitSuppress", got)
	}
}

func TestStructuralKey_IgnoresMetadataButTracksIdentity(t *testing.T) {
	a := []types.AgentStateUpdate{agent("a", "1", "running", map[string]any{"n": 1})}
	b := []types.AgentStateUpdate{agent("a", "1", "running", map[string]any{"n": 999})}
	if structuralKey(a) != structuralKey(b) {
		t.Error("metadata-only difference must not register as structural")
	}

	c := []types.AgentStateUpdate{agent("a", "1", "done", map[string]any{"n": 1})}
	if structuralKey(a) == structuralKey(c) {
		t.Error("a status change must register as structural")
	}
}

// Determinism is load-bearing: encoding/json sorts map keys, so equal content
// hashes equal. Without that, dedup would never fire.
func TestSnapshotHash_IsDeterministicAcrossMapOrdering(t *testing.T) {
	a := []types.AgentStateUpdate{agent("a", "1", "running", map[string]any{
		"zebra": 1, "alpha": 2, "middle": 3,
	})}
	b := []types.AgentStateUpdate{agent("a", "1", "running", map[string]any{
		"middle": 3, "alpha": 2, "zebra": 1,
	})}

	if snapshotHash(a) != snapshotHash(b) {
		t.Error("equal content must hash equally regardless of map insertion order")
	}

	c := []types.AgentStateUpdate{agent("a", "1", "running", map[string]any{"zebra": 2})}
	if snapshotHash(a) == snapshotHash(c) {
		t.Error("different content must hash differently")
	}
}

func TestAgentEmitter_ConcurrentDecidesAreSafe(t *testing.T) {
	e := &agentEmitter{}
	limits := testLimits()
	limits.CoalesceMs = 5

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			snap := []types.AgentStateUpdate{agent("a", "1", "running", map[string]any{"n": n})}
			e.decide(snap, "r", false, limits, noFlush)
		}(i)
	}
	wg.Wait()
	e.stop()
}
