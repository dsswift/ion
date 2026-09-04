package session

import (
	"sync/atomic"
	"testing"
	"time"
)

// TestSendPrompt_BlockedContextInjection_DoesNotWedgeOtherSessions pins the
// core fix for the live-process wedge incident: context-file discovery,
// workspace lookup, and plugin injection now run AFTER m.mu is released (see
// prompt_dispatch.go's "off-lock inject" section). Before that change, a single
// session whose inject step stalled on I/O would hold m.mu for the duration,
// wedging every other session's
// StartSession/SendPrompt/status call behind it — exactly what the incident
// showed: one stalled prompt on conversation 1786321978902-9996c0daf5cd froze
// the whole engine.
//
// testInjectContextFilesHook lets us simulate that stall deterministically
// (blocking on a channel) without depending on a real slow filesystem.
//
// Revert check: if injectContextFiles (or any of
// injectWorkspaceContext / injectExtensionContext / injectPluginContext) is
// ever moved back under m.mu, this test hangs until its own timeout and fails,
// because StartSession("other-session", ...) will block behind the stalled
// session's lock instead of completing immediately.
func TestSendPrompt_BlockedContextInjection_DoesNotWedgeOtherSessions(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	var claimed atomic.Bool

	// testInjectContextFilesHook is a single package-global hook shared by every
	// session's injectContextFiles call. sync.Once is NOT usable here: Once.Do
	// blocks every concurrent caller (not just the first) until the winning
	// call returns, which would make the "other" session block on the Once
	// itself rather than on m.mu -- masking exactly the bug this test exists
	// to catch. A CompareAndSwap claims the stall for the first caller only;
	// every later caller (the other session) returns immediately, exactly as
	// it would with a real, unstalled context-file walk.
	testInjectContextFilesHook = func() {
		if claimed.CompareAndSwap(false, true) {
			entered <- struct{}{}
			<-release
		}
	}
	defer func() { testInjectContextFilesHook = nil }()

	mb := newMockBackend()
	mgr := NewManager(mb)

	if _, err := mgr.StartSession("blocked-session", defaultConfig()); err != nil {
		t.Fatalf("StartSession(blocked-session): %v", err)
	}

	blockedDone := make(chan error, 1)
	go func() {
		blockedDone <- mgr.SendPrompt("blocked-session", "hello", nil)
	}()

	// Wait until the blocked session's inject phase has actually entered the
	// hook (proves it is mid-stall, not merely not-yet-scheduled) before
	// asserting anything about concurrent access.
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("blocked session's injectContextFiles hook never entered")
	}

	// While the blocked session's context injection is stalled indefinitely,
	// a second session must be able to start, prompt, and complete without
	// waiting on the manager mutex.
	otherDone := make(chan error, 1)
	go func() {
		if _, err := mgr.StartSession("other-session", defaultConfig()); err != nil {
			otherDone <- err
			return
		}
		otherDone <- mgr.SendPrompt("other-session", "hi", nil)
	}()

	select {
	case err := <-otherDone:
		if err != nil {
			t.Fatalf("other session failed while first session was blocked: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("other session wedged behind blocked session's context injection — m.mu was held during inject")
	}

	// A status-shaped read (StartSession is idempotent and takes m.mu itself)
	// must also stay responsive.
	statusDone := make(chan error, 1)
	go func() {
		_, err := mgr.StartSession("blocked-session", defaultConfig())
		statusDone <- err
	}()
	select {
	case err := <-statusDone:
		if err != nil {
			t.Fatalf("idempotent StartSession on blocked session failed: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("idempotent StartSession on the blocked session's own key wedged — m.mu was held during inject")
	}

	// Release the stalled session and confirm it eventually completes.
	close(release)
	select {
	case err := <-blockedDone:
		if err != nil {
			t.Fatalf("blocked session's SendPrompt returned error after release: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("blocked session never completed after release")
	}
}
