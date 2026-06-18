package server

import (
	"net"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// fakeConn is a net.Conn stub usable only as a map key / identity token in
// sessionOwnership tests. None of its I/O methods are exercised.
type fakeConn struct{ id int }

func (f *fakeConn) Read([]byte) (int, error)         { return 0, nil }
func (f *fakeConn) Write([]byte) (int, error)        { return 0, nil }
func (f *fakeConn) Close() error                     { return nil }
func (f *fakeConn) LocalAddr() net.Addr              { return nil }
func (f *fakeConn) RemoteAddr() net.Addr             { return nil }
func (f *fakeConn) SetDeadline(time.Time) error      { return nil }
func (f *fakeConn) SetReadDeadline(time.Time) error  { return nil }
func (f *fakeConn) SetWriteDeadline(time.Time) error { return nil }

// reapRecorder collects the keys passed to the reap callback.
type reapRecorder struct {
	mu   sync.Mutex
	keys []string
	ch   chan string
}

func newReapRecorder() *reapRecorder {
	return &reapRecorder{ch: make(chan string, 16)}
}

func (r *reapRecorder) reap(key string) {
	r.mu.Lock()
	r.keys = append(r.keys, key)
	r.mu.Unlock()
	r.ch <- key
}

func (r *reapRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.keys)
}

// withReapGraceWindow temporarily shrinks the grace window so reaping tests do
// not wait minutes. Restored on cleanup.
func withReapGraceWindow(t *testing.T, d time.Duration) {
	t.Helper()
	prev := reapGraceWindow
	reapGraceWindow = d
	t.Cleanup(func() { reapGraceWindow = prev })
}

// TestOwnership_ReapsAfterLastOwnerDisconnects is the core regression test:
// a session claimed by exactly one connection is reaped after that connection
// disconnects and the grace window elapses with no re-claim.
//
// Reverting the releaseConn → scheduleReap wiring (or evictClient's
// releaseConn call) leaves the session un-reaped, so the reap callback never
// fires and this test times out / fails.
func TestOwnership_ReapsAfterLastOwnerDisconnects(t *testing.T) {
	withReapGraceWindow(t, 30*time.Millisecond)
	rec := newReapRecorder()
	o := newSessionOwnership(rec.reap)

	c := &fakeConn{id: 1}
	o.claim(c, "sess-A")

	// Disconnect the sole owner.
	o.releaseConn(c)

	select {
	case key := <-rec.ch:
		if key != "sess-A" {
			t.Fatalf("reaped key = %q, want sess-A", key)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("session was not reaped after last owner disconnected")
	}
}

// TestOwnership_ReclaimWithinGraceCancelsReap verifies that a reconnect that
// re-claims the key within the grace window cancels the reap entirely.
func TestOwnership_ReclaimWithinGraceCancelsReap(t *testing.T) {
	withReapGraceWindow(t, 80*time.Millisecond)
	rec := newReapRecorder()
	o := newSessionOwnership(rec.reap)

	c1 := &fakeConn{id: 1}
	o.claim(c1, "sess-B")
	o.releaseConn(c1) // last owner gone, grace window starts

	// Reconnect on a new connection and re-claim well within the window.
	time.Sleep(20 * time.Millisecond)
	c2 := &fakeConn{id: 2}
	o.claim(c2, "sess-B")

	// Wait past the original window; the reap must NOT have fired.
	time.Sleep(120 * time.Millisecond)
	if n := rec.count(); n != 0 {
		t.Fatalf("reap fired %d times despite re-claim within grace window", n)
	}
}

// TestOwnership_MultiOwnerNotReapedUntilLastLeaves verifies that a session
// owned by two connections is not reaped when only one disconnects, and is
// reaped only after the second also disconnects.
func TestOwnership_MultiOwnerNotReapedUntilLastLeaves(t *testing.T) {
	withReapGraceWindow(t, 30*time.Millisecond)
	rec := newReapRecorder()
	o := newSessionOwnership(rec.reap)

	c1 := &fakeConn{id: 1}
	c2 := &fakeConn{id: 2}
	o.claim(c1, "sess-C")
	o.claim(c2, "sess-C")

	// First owner leaves: must NOT schedule a reap (c2 still owns it).
	o.releaseConn(c1)
	time.Sleep(80 * time.Millisecond)
	if n := rec.count(); n != 0 {
		t.Fatalf("reap fired %d times while a second owner was still connected", n)
	}

	// Second owner leaves: now it must be reaped.
	o.releaseConn(c2)
	select {
	case key := <-rec.ch:
		if key != "sess-C" {
			t.Fatalf("reaped key = %q, want sess-C", key)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("session not reaped after last of two owners disconnected")
	}
}

// TestOwnership_DisconnectWithNoSessionsIsNoop ensures releasing a connection
// that never claimed anything does not schedule a reap or panic.
func TestOwnership_DisconnectWithNoSessionsIsNoop(t *testing.T) {
	withReapGraceWindow(t, 20*time.Millisecond)
	rec := newReapRecorder()
	o := newSessionOwnership(rec.reap)

	o.releaseConn(&fakeConn{id: 99})
	time.Sleep(60 * time.Millisecond)
	if n := rec.count(); n != 0 {
		t.Fatalf("reap fired %d times for a connection that owned no sessions", n)
	}
}

// TestOwnership_StopAllCancelsPendingReaps verifies that stopAll (server
// shutdown) cancels in-flight grace timers so a reap cannot fire into a
// torn-down manager.
func TestOwnership_StopAllCancelsPendingReaps(t *testing.T) {
	withReapGraceWindow(t, 50*time.Millisecond)
	rec := newReapRecorder()
	o := newSessionOwnership(rec.reap)

	c := &fakeConn{id: 1}
	o.claim(c, "sess-D")
	o.releaseConn(c) // arms the grace timer

	o.stopAll() // must cancel it

	time.Sleep(120 * time.Millisecond)
	if n := rec.count(); n != 0 {
		t.Fatalf("reap fired %d times after stopAll cancelled pending reaps", n)
	}
}

// hasSession reports whether the manager currently holds a session for key.
func hasSession(srv *Server, key string) bool {
	for _, si := range srv.manager.ListSessions() {
		if si.Key == key {
			return true
		}
	}
	return false
}

// TestServer_DisconnectReapsOrphanedSession is the end-to-end regression test
// for the FD-leak fix: a client starts a session, then disconnects without
// sending stop_session. After the grace window the server must reap the
// orphaned session through Manager.StopSession (releasing its pooled watcher).
//
// Reverting evictClient's releaseConn call (or the releaseConn → reap wiring)
// leaves the session resident forever, so hasSession stays true and this test
// fails — exactly the production leak it pins.
func TestServer_DisconnectReapsOrphanedSession(t *testing.T) {
	withReapGraceWindow(t, 40*time.Millisecond)
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn := dialServer(t, srv)
	startSession(t, conn, "orphan-1", "req-orphan")

	if !hasSession(srv, "orphan-1") {
		t.Fatal("session not registered after start_session")
	}

	// Disconnect WITHOUT stop_session — the orphaning condition.
	conn.Close()

	// Within the grace window the session must still exist (a transient flap
	// should not tear it down instantly).
	time.Sleep(10 * time.Millisecond)
	if !hasSession(srv, "orphan-1") {
		t.Fatal("session reaped before grace window elapsed")
	}

	// After the grace window the orphaned session must be gone.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !hasSession(srv, "orphan-1") {
			return // reaped — success
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("orphaned session was not reaped after grace window")
}

// TestServer_ReconnectCancelsReap proves a client that reconnects and
// re-addresses the session within the grace window keeps it alive: the new
// connection's start_session re-claims ownership and cancels the reap.
func TestServer_ReconnectCancelsReap(t *testing.T) {
	withReapGraceWindow(t, 120*time.Millisecond)
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn1 := dialServer(t, srv)
	startSession(t, conn1, "keep-1", "req-k1")
	conn1.Close() // last owner gone, grace window starts

	// Reconnect within the window and re-claim the same key.
	time.Sleep(30 * time.Millisecond)
	conn2 := dialServer(t, srv)
	defer conn2.Close()
	startSession(t, conn2, "keep-1", "req-k2")

	// Wait past the original window; the session must survive.
	time.Sleep(160 * time.Millisecond)
	if !hasSession(srv, "keep-1") {
		t.Fatal("session was reaped despite a reconnect re-claim within the grace window")
	}
}

// TestServer_SetConfigAppliesReapGraceWindow proves the configurable
// workspace.sessionReapGraceMs is honored: a server configured with a short
// window reaps an orphaned session on roughly that cadence, even though the
// compiled default is 5 minutes. Without SetConfig wiring the value through to
// sessionOwnership, the default would keep the session alive and this test's
// bounded wait would fail.
func TestServer_SetConfigAppliesReapGraceWindow(t *testing.T) {
	// Keep the compiled default large so the only way the session is reaped
	// inside the test's wait is the configured short window taking effect.
	withReapGraceWindow(t, 5*time.Minute)
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	// Configure a short grace window via the workspace config block.
	srv.SetConfig(&types.EngineRuntimeConfig{
		Workspace: &types.WorkspaceConfig{SessionReapGraceMs: 40}, // 40ms
	})

	conn := dialServer(t, srv)
	startSession(t, conn, "cfg-grace", "req-cfg")
	if !hasSession(srv, "cfg-grace") {
		t.Fatal("session not registered after start_session")
	}
	conn.Close()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !hasSession(srv, "cfg-grace") {
			return // reaped on the configured short cadence — success
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("session not reaped within the configured short grace window")
}

