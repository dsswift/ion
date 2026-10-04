package session

import (
	"github.com/dsswift/ion/engine/internal/session/agents"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/pending"
)

// Human-wait seam tests at the session layer.
//
// These pin that Manager.beginHumanWait / endHumanWait forward to the resolved
// backend's BeginHumanWait / EndHumanWait for the session's active requestID, and
// that Manager.elicit brackets its blocking wait with the pair so the run-progress
// watchdog is paused for exactly the elicitation span. The watchdog itself (depth
// → idle-exemption) is pinned in the backend package.

// newHumanWaitMockSession builds a Manager wired to a recording mock backend with
// one session whose requestID is set.
func newHumanWaitMockSession(t *testing.T) (*Manager, *mockBackend, *engineSession, string) {
	t.Helper()
	const key = "hw-session"
	const requestID = "hw-req-1"
	mb := newMockBackend()
	m := &Manager{sessions: make(map[string]*engineSession), backend: mb}
	s := &engineSession{agents: agents.NewRegistry(), key: key, pending: pending.New(), requestID: requestID}
	s.newSessionRootContext()
	m.sessions[key] = s
	return m, mb, s, requestID
}

// TestBeginEndHumanWait_ForwardsToBackend pins the session→backend resolution:
// beginHumanWait / endHumanWait forward to the backend keyed by the session's
// current requestID.
func TestBeginEndHumanWait_ForwardsToBackend(t *testing.T) {
	m, mb, s, requestID := newHumanWaitMockSession(t)

	m.beginHumanWait(s)
	if begin, end := mb.humanWaitCounts(requestID); begin != 1 || end != 0 {
		t.Fatalf("after beginHumanWait: begin=%d end=%d, want 1/0", begin, end)
	}
	m.endHumanWait(s)
	if begin, end := mb.humanWaitCounts(requestID); begin != 1 || end != 1 {
		t.Fatalf("after endHumanWait: begin=%d end=%d, want 1/1", begin, end)
	}
}

// TestBeginEndHumanWait_NoActiveRunIsNoop pins that with no active run (empty
// requestID) the helpers do not forward — there is no run to suspend.
func TestBeginEndHumanWait_NoActiveRunIsNoop(t *testing.T) {
	m, mb, s, _ := newHumanWaitMockSession(t)
	s.requestID = "" // no active run

	m.beginHumanWait(s)
	m.endHumanWait(s)
	if begin, end := mb.humanWaitCounts(""); begin != 0 || end != 0 {
		t.Fatalf("no-active-run human-wait forwarded: begin=%d end=%d, want 0/0", begin, end)
	}
}

// TestElicitBracketsHumanWait pins that Manager.elicit opens a human-wait before
// blocking and closes it after resolving: exactly one Begin and one End land on
// the active requestID across the full elicit lifecycle (client reply path).
func TestElicitBracketsHumanWait(t *testing.T) {
	m, mb, s, requestID := newHumanWaitMockSession(t)
	key := s.key

	resCh := make(chan map[string]interface{}, 1)
	go func() {
		resp, _, _ := m.elicit(s, key, extension.ElicitationRequestInfo{RequestID: "e1"})
		resCh <- resp
	}()

	// Poll until the elicit has entered its human-wait (Begin recorded).
	if !waitForCount(func() int { b, _ := mb.humanWaitCounts(requestID); return b }, 1) {
		t.Fatal("elicit did not open a human-wait before blocking (Begin never recorded)")
	}
	// While blocked, End must not have fired yet.
	if _, end := mb.humanWaitCounts(requestID); end != 0 {
		t.Fatalf("elicit closed the human-wait before resolving: end=%d, want 0", end)
	}

	// Resolve via client reply; the deferred endHumanWait must close the wait.
	m.HandleElicitationResponse(key, "e1", map[string]interface{}{"answer": "yes"}, false)

	select {
	case resp := <-resCh:
		if resp["answer"] != "yes" {
			t.Errorf("elicit response = %v, want answer=yes", resp)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("elicit did not resolve on client reply")
	}

	if !waitForCount(func() int { _, e := mb.humanWaitCounts(requestID); return e }, 1) {
		_, end := mb.humanWaitCounts(requestID)
		t.Fatalf("elicit did not close the human-wait after resolving: end=%d, want 1", end)
	}
	// Exactly one Begin total (no spurious extra waits).
	if begin, _ := mb.humanWaitCounts(requestID); begin != 1 {
		t.Fatalf("elicit opened %d human-waits, want exactly 1", begin)
	}
}

// TestElicitBracketsHumanWait_RootCancelPath pins that the End fires even when the
// wait is released by session teardown rather than a client reply.
func TestElicitBracketsHumanWait_RootCancelPath(t *testing.T) {
	m, mb, s, requestID := newHumanWaitMockSession(t)
	key := s.key

	done := make(chan struct{})
	go func() {
		_, _, _ = m.elicit(s, key, extension.ElicitationRequestInfo{RequestID: "e1"})
		close(done)
	}()

	if !waitForCount(func() int { b, _ := mb.humanWaitCounts(requestID); return b }, 1) {
		t.Fatal("elicit did not open a human-wait before blocking")
	}
	s.cancelSessionRoot("test abort")

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("elicit did not return after root cancellation")
	}
	if !waitForCount(func() int { _, e := mb.humanWaitCounts(requestID); return e }, 1) {
		t.Fatal("elicit did not close the human-wait on root cancellation")
	}
}

// waitForCount polls get() until it reaches want or a short deadline elapses.
func waitForCount(get func() int, want int) bool {
	deadline := time.After(2 * time.Second)
	for {
		if get() >= want {
			return true
		}
		select {
		case <-deadline:
			return false
		case <-time.After(2 * time.Millisecond):
		}
	}
}
