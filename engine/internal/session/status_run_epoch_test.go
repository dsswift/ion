package session

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// The run epoch is the ordering signal a consumer uses to tell a status
// snapshot built BEFORE its prompt from the snapshot that ends the resulting
// run. Both look like state=idle; only the epoch separates them.
//
// The defect these tests pin: start_session issues a reconcile handshake, and
// the heartbeat, ReconcileState, and QuerySessionStatus each emit on their own
// schedule. Any of them can build a snapshot in the window after a client
// dispatched a prompt but before SendPrompt assigned run identity. That
// snapshot honestly reports idle, and a consumer with no ordering signal reads
// it as the completion of the prompt it just sent — marking a conversation
// done seconds before its run begins.

func TestBuildStatusFields_RunEpochStartsAtZeroBeforeAnyDispatch(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "epoch-fresh"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	fields, ok := mgr.buildStatusFields(key)
	if !ok {
		t.Fatal("buildStatusFields returned no session")
	}
	if fields.RunEpoch != 0 {
		t.Fatalf("RunEpoch = %d, want 0 for a session that has never dispatched", fields.RunEpoch)
	}
	if fields.State != "idle" {
		t.Fatalf("State = %q, want idle", fields.State)
	}
}

// The core ordering guarantee: a snapshot built before the dispatch carries a
// STRICTLY LOWER epoch than every snapshot built after it. This is what lets a
// consumer classify the pre-dispatch idle as "not my completion".
func TestBuildStatusFields_RunEpochAdvancesOnDispatch(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "epoch-advance"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// The snapshot a reconcile / heartbeat would produce before the prompt.
	before, ok := mgr.buildStatusFields(key)
	if !ok {
		t.Fatal("buildStatusFields returned no session")
	}

	// Simulate exactly what SendPrompt does at the dispatch seam: assign run
	// identity and advance the epoch under one lock hold.
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.setRunIdentity("run-1", "trace-1")
	s.dispatchingRunID = "run-1"
	s.runEpoch++
	mgr.mu.Unlock()

	after, ok := mgr.buildStatusFields(key)
	if !ok {
		t.Fatal("buildStatusFields returned no session")
	}

	if after.RunEpoch <= before.RunEpoch {
		t.Fatalf("RunEpoch did not advance across dispatch: before=%d after=%d", before.RunEpoch, after.RunEpoch)
	}
	if before.RunEpoch != 0 || after.RunEpoch != 1 {
		t.Fatalf("RunEpoch = %d -> %d, want 0 -> 1", before.RunEpoch, after.RunEpoch)
	}
}

// The epoch is read under the same lock hold as State, so the pair can never
// disagree. A snapshot reporting the run as live must carry the epoch that run
// established — otherwise a consumer would see running at a stale epoch and
// still classify it as pre-dispatch.
func TestBuildStatusFields_RunEpochAgreesWithRunningState(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "epoch-running"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.setRunIdentity("live-run", "trace-live")
	s.dispatchingRunID = "live-run"
	s.runEpoch++
	mgr.mu.Unlock()

	fields, ok := mgr.buildStatusFields(key)
	if !ok {
		t.Fatal("buildStatusFields returned no session")
	}
	if fields.State != "running" {
		t.Fatalf("State = %q, want running", fields.State)
	}
	if fields.RunEpoch != 1 {
		t.Fatalf("RunEpoch = %d, want 1 alongside running state", fields.RunEpoch)
	}
}

// The idle that ENDS a run keeps the epoch that run established. This is the
// case a consumer must accept as a genuine completion, and it is what
// distinguishes it from the pre-dispatch idle in the first test.
func TestBuildStatusFields_RunEpochRetainedOnRunExitIdle(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "epoch-exit"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.setRunIdentity("run-1", "trace-1")
	s.dispatchingRunID = "run-1"
	s.runEpoch++
	mgr.mu.Unlock()

	// Run exits: identity clears, but the epoch is a monotonic history of
	// accepted dispatches and must NOT rewind.
	mgr.mu.Lock()
	s.clearRunIdentity()
	s.dispatchingRunID = ""
	mgr.mu.Unlock()

	fields, ok := mgr.buildStatusFields(key)
	if !ok {
		t.Fatal("buildStatusFields returned no session")
	}
	if fields.State != "idle" {
		t.Fatalf("State = %q, want idle after run exit", fields.State)
	}
	if fields.RunEpoch != 1 {
		t.Fatalf("RunEpoch = %d, want 1 retained after run exit", fields.RunEpoch)
	}
}

// A second dispatch must be distinguishable from the first, so a consumer that
// sends two prompts in a row can order each snapshot against the right one.
func TestBuildStatusFields_RunEpochIsMonotonicAcrossRuns(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "epoch-monotonic"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	var seen []int64
	for i := 0; i < 3; i++ {
		mgr.mu.Lock()
		s := mgr.sessions[key]
		s.runEpoch++
		mgr.mu.Unlock()

		fields, ok := mgr.buildStatusFields(key)
		if !ok {
			t.Fatal("buildStatusFields returned no session")
		}
		seen = append(seen, fields.RunEpoch)
	}

	for i := 1; i < len(seen); i++ {
		if seen[i] <= seen[i-1] {
			t.Fatalf("RunEpoch not monotonic: %v", seen)
		}
	}
}

// The epoch must survive onto the wire. A Go-side field that is dropped by
// serialization gives a consumer nothing to order against, which is the whole
// defect. Zero stays omitted so a never-dispatched session is indistinguishable
// from an emitter that predates the field — consumers treat absent as zero.
// engine_session_status is the designated successor to engine_status. A
// consumer that reads only the successor needs the same ordering signal, so
// the mirror must carry the epoch. Without this, retiring the legacy event
// reintroduces the false-completion defect.
func TestRunEpoch_CarriedOntoSessionStatusMirror(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "epoch-mirror"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.runEpoch++
	mgr.mu.Unlock()

	fields, ok := mgr.buildStatusFields(key)
	if !ok {
		t.Fatal("buildStatusFields returned no session")
	}
	mirror := buildSessionStatusMirror(key, fields, s)
	if mirror.SessionStatus == nil {
		t.Fatal("mirror carried no SessionStatus payload")
	}
	if mirror.SessionStatus.RunEpoch != fields.RunEpoch {
		t.Fatalf("mirror RunEpoch = %d, want %d from the status snapshot",
			mirror.SessionStatus.RunEpoch, fields.RunEpoch)
	}
	if mirror.SessionStatus.RunEpoch != 1 {
		t.Fatalf("mirror RunEpoch = %d, want 1", mirror.SessionStatus.RunEpoch)
	}
}

func TestRunEpoch_SerializesOntoTheWire(t *testing.T) {
	present, err := json.Marshal(types.StatusFields{State: "idle", RunEpoch: 4})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(present), `"runEpoch":4`) {
		t.Fatalf("RunEpoch missing from wire payload: %s", present)
	}

	absent, err := json.Marshal(types.StatusFields{State: "idle"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(absent), "runEpoch") {
		t.Fatalf("zero RunEpoch should be omitted, got: %s", absent)
	}
}
