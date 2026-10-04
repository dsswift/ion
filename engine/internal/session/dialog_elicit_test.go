package session

import (
	"context"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/types"
)

// newElicitTestSession builds a minimal manager+session wired with a pending
// broker and a live root context, sufficient to drive elicit() directly.
func newElicitTestSession(t *testing.T, timeouts *types.TimeoutsConfig) (*Manager, *engineSession, string) {
	t.Helper()
	key := "test-session"
	m := &Manager{sessions: make(map[string]*engineSession)}
	if timeouts != nil {
		m.config = &types.EngineRuntimeConfig{Timeouts: timeouts}
	}
	s := &engineSession{agents: agents.NewRegistry(), key: key, pending: pending.New()}
	s.newSessionRootContext()
	m.sessions[key] = s
	return m, s, key
}

// TestElicit_IndefiniteByDefault_DoesNotAutoCancel pins the core human-wait
// guarantee: with no timeouts config (the shipped default), an unanswered
// elicitation does NOT return on its own within a generous window. Revert-check:
// reinstating the old 5-minute time.After with a small value would make this
// return cancelled and fail.
func TestElicit_IndefiniteByDefault_DoesNotAutoCancel(t *testing.T) {
	m, s, key := newElicitTestSession(t, nil)

	done := make(chan struct{})
	go func() {
		_, _, _ = m.elicit(s, key, extension.ElicitationRequestInfo{RequestID: "e1"})
		close(done)
	}()

	select {
	case <-done:
		t.Fatal("elicit returned on its own — indefinite wait not honored")
	case <-time.After(300 * time.Millisecond):
		// expected: still blocked. Clean up by cancelling the session root.
	}
	s.cancelSessionRoot("test cleanup")
	select {
	case <-done:
		// expected: root cancellation unblocked it
	case <-time.After(time.Second):
		t.Fatal("elicit did not unblock after root cancellation")
	}
}

// TestElicit_RootCancellationUnblocks pins that session teardown/abort releases
// an indefinitely-waiting elicitation, returning cancelled=true.
func TestElicit_RootCancellationUnblocks(t *testing.T) {
	m, s, key := newElicitTestSession(t, nil)

	type result struct {
		cancelled bool
		err       error
	}
	resCh := make(chan result, 1)
	go func() {
		_, cancelled, err := m.elicit(s, key, extension.ElicitationRequestInfo{RequestID: "e1"})
		resCh <- result{cancelled, err}
	}()

	// Let the elicit register and block, then cancel.
	time.Sleep(50 * time.Millisecond)
	s.cancelSessionRoot("user abort")

	select {
	case r := <-resCh:
		if !r.cancelled {
			t.Error("expected cancelled=true after root cancellation")
		}
		if r.err == nil {
			t.Error("expected non-nil error after root cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("elicit did not return after root cancellation")
	}
}

// TestElicit_ClientReplyWins pins that a client reply resolves the elicit with
// the response, independent of the (indefinite) wait.
func TestElicit_ClientReplyWins(t *testing.T) {
	m, s, key := newElicitTestSession(t, nil)

	resCh := make(chan map[string]interface{}, 1)
	go func() {
		resp, _, _ := m.elicit(s, key, extension.ElicitationRequestInfo{RequestID: "e1"})
		resCh <- resp
	}()

	time.Sleep(50 * time.Millisecond)
	m.HandleElicitationResponse(key, "e1", map[string]interface{}{"answer": "yes"}, false)

	select {
	case resp := <-resCh:
		if resp["answer"] != "yes" {
			t.Errorf("response = %v, want answer=yes", resp)
		}
	case <-time.After(time.Second):
		t.Fatal("elicit did not resolve on client reply")
	}
}

// TestElicit_FiniteOverrideTimesOut pins that a configured finite human-wait
// returns cancelled=true at the deadline (headless deployment behavior).
func TestElicit_FiniteOverrideTimesOut(t *testing.T) {
	m, s, key := newElicitTestSession(t, &types.TimeoutsConfig{ElicitationMs: 60}) // 60ms finite

	start := time.Now()
	_, cancelled, err := m.elicit(s, key, extension.ElicitationRequestInfo{RequestID: "e1"})
	elapsed := time.Since(start)

	if !cancelled {
		t.Error("expected cancelled=true on finite-wait expiry")
	}
	if err == nil {
		t.Error("expected timeout error on finite-wait expiry")
	}
	if elapsed > 2*time.Second {
		t.Errorf("finite wait took %s, expected ~60ms", elapsed)
	}
}

// TestElicit_SuspenderBracketsWait pins Option B at the session seam: when the
// accessor carries a DeadlineSuspender, the Elicit accessor pauses it for the
// duration of the wait and resumes after. We assert the suspender is paused
// while the elicit is blocked and resumed once it resolves.
func TestElicit_SuspenderBracketsWait(t *testing.T) {
	m, s, key := newElicitTestSession(t, nil)

	// A context whose deadline would fire quickly if NOT paused.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ds := types.NewDeadlineSuspender(80*time.Millisecond, cancel)
	defer ds.Stop()

	acc := &sessionAccessor{m: m, s: s, key: key, suspender: ds}

	done := make(chan struct{})
	go func() {
		_, _, _ = acc.Elicit(extension.ElicitationRequestInfo{RequestID: "e1"})
		close(done)
	}()

	// While blocked on the human, the suspender is paused, so the 80ms deadline
	// must NOT fire even after we wait well past it.
	select {
	case <-ctx.Done():
		t.Fatal("tool deadline fired during human-wait — suspender not pausing")
	case <-time.After(250 * time.Millisecond):
		// expected: suspended
	}

	// Resolve the elicit; Elicit's deferred Resume re-arms the deadline.
	m.HandleElicitationResponse(key, "e1", map[string]interface{}{"ok": true}, false)
	<-done

	select {
	case <-ctx.Done():
		// expected: re-armed deadline fires after resume
	case <-time.After(time.Second):
		t.Fatal("tool deadline did not re-arm after elicit resolved")
	}
}
