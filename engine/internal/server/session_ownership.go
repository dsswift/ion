package server

import (
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// reapGraceWindow is the COMPILED DEFAULT for how long a session whose last
// owning connection disconnected is kept alive before it is reaped
// (StopSession). The window tolerates a normal desktop restart / socket flap:
// a client that reconnects and re-addresses the same session key within the
// window cancels the pending reap, so a transient disconnect never tears down
// a session the user is still working in. Long enough for a desktop relaunch;
// short enough that orphaned sessions (and their pooled filesystem-watcher
// FDs) cannot accumulate unbounded across reconnect churn.
//
// This is only the default seed for newSessionOwnership. Consumers override it
// via engine.json's workspace.sessionReapGraceMs, applied per-instance through
// Server.SetConfig → sessionOwnership.setGraceWindow. Keeping a package var
// (not const) also lets tests shrink the window to assert reaping without
// waiting minutes.
var reapGraceWindow = 5 * time.Minute

// sessionOwnership tracks, per live client connection, which session keys that
// connection has claimed (via start_session / send_prompt) and the reverse
// index (key -> owning connections). When the last owner of a key disconnects,
// the key is scheduled for a grace-windowed reap.
//
// This is the engine's answer to the orphaned-session FD leak: sessions are
// addressed by key from any connection and are intentionally decoupled from a
// single connection so a client can reconnect and resume. But nothing reaped a
// session whose owning client disconnected and reconnected under a *new* key
// (new engine-instance id), so the old session — and its ~1-FD-per-watched-dir
// workspace watcher — leaked until engine restart. This binds session liveness
// to connection liveness with a reconnect grace window.
type sessionOwnership struct {
	mu sync.Mutex
	// byConn maps a connection to the set of session keys it owns.
	byConn map[net.Conn]map[string]struct{}
	// owners maps a session key to the set of connections that own it.
	owners map[string]map[net.Conn]struct{}
	// pendingReaps holds the timer for each key currently in its grace window
	// (last owner gone, not yet reaped). Re-claiming the key cancels the timer.
	pendingReaps map[string]*time.Timer
	// reap is the function invoked when a key's grace window expires with no
	// surviving owner. Injected so tests can observe reaping without a real
	// manager; production wires it to Manager.StopSession.
	reap func(key string)
	// graceWindow is captured from reapGraceWindow at construction so each
	// instance has a stable window that cannot be raced by a test mutating the
	// package var while this instance's timer goroutines read it.
	graceWindow time.Duration
}

func newSessionOwnership(reap func(key string)) *sessionOwnership {
	return &sessionOwnership{
		byConn:       make(map[net.Conn]map[string]struct{}),
		owners:       make(map[string]map[net.Conn]struct{}),
		pendingReaps: make(map[string]*time.Timer),
		reap:         reap,
		graceWindow:  reapGraceWindow,
	}
}

// setGraceWindow overrides the reap grace window from engine config. Called
// from Server.SetConfig at startup, before any client connects. Guarded by mu
// so it is safe against a concurrent reader even though, in practice, no timer
// is armed this early.
func (o *sessionOwnership) setGraceWindow(d time.Duration) {
	if d <= 0 {
		return
	}
	o.mu.Lock()
	o.graceWindow = d
	o.mu.Unlock()
	utils.Info("Server", fmt.Sprintf("sessionOwnership: reap grace window set to %s", d))
}

// claim records that conn owns the given session key. Idempotent. If the key
// had a pending reap (its last owner had disconnected and the grace window was
// running), the reap is cancelled because the session is live again.
func (o *sessionOwnership) claim(conn net.Conn, key string) {
	if conn == nil || key == "" {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()

	if o.byConn[conn] == nil {
		o.byConn[conn] = make(map[string]struct{})
	}
	o.byConn[conn][key] = struct{}{}

	if o.owners[key] == nil {
		o.owners[key] = make(map[net.Conn]struct{})
	}
	o.owners[key][conn] = struct{}{}

	// Cancel any pending reap: the key has a live owner again.
	if t, ok := o.pendingReaps[key]; ok {
		t.Stop()
		delete(o.pendingReaps, key)
		utils.Info("Server", fmt.Sprintf("sessionOwnership.claim: cancelled pending reap key=%s (re-owned)", key))
	}
}

// releaseConn removes a disconnected connection from the ownership maps and
// schedules a grace-windowed reap for every key that no longer has any live
// owner. Called from evictClient.
func (o *sessionOwnership) releaseConn(conn net.Conn) {
	if conn == nil {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()

	keys := o.byConn[conn]
	delete(o.byConn, conn)
	if len(keys) == 0 {
		return
	}

	for key := range keys {
		owners := o.owners[key]
		delete(owners, conn)
		if len(owners) == 0 {
			delete(o.owners, key)
			o.scheduleReapLocked(key)
		} else {
			utils.Debug("Server", fmt.Sprintf("sessionOwnership.releaseConn: key=%s still has %d owner(s), not reaping", key, len(owners)))
		}
	}
}

// scheduleReapLocked arms the grace-window timer for a now-ownerless key. The
// caller must hold o.mu. If a timer already exists for the key it is left in
// place (the existing window is authoritative). When the timer fires it
// re-checks under the lock that the key is still ownerless before reaping, so a
// claim that raced the timer's start does not get clobbered.
func (o *sessionOwnership) scheduleReapLocked(key string) {
	if _, exists := o.pendingReaps[key]; exists {
		return
	}
	utils.Info("Server", fmt.Sprintf("sessionOwnership: last owner gone, scheduling reap key=%s grace=%s", key, o.graceWindow))
	o.pendingReaps[key] = time.AfterFunc(o.graceWindow, func() {
		o.mu.Lock()
		// Re-check: a reconnect within the window may have re-claimed the key,
		// which would have stopped this timer and deleted the entry. If the
		// entry is gone, the timer fired after a cancel race — do nothing.
		if _, still := o.pendingReaps[key]; !still {
			o.mu.Unlock()
			return
		}
		delete(o.pendingReaps, key)
		// Owners may have reappeared between Stop races; double-check.
		if owners := o.owners[key]; len(owners) > 0 {
			o.mu.Unlock()
			utils.Info("Server", fmt.Sprintf("sessionOwnership: reap aborted key=%s (re-owned during window)", key))
			return
		}
		reap := o.reap
		o.mu.Unlock()

		utils.Info("Server", fmt.Sprintf("sessionOwnership: grace window expired, reaping orphaned session key=%s", key))
		if reap != nil {
			reap(key)
		}
	})
}

// stopAll cancels every pending reap timer. Called on server shutdown so a
// fired timer cannot reach into a torn-down manager.
func (o *sessionOwnership) stopAll() {
	o.mu.Lock()
	defer o.mu.Unlock()
	for key, t := range o.pendingReaps {
		t.Stop()
		delete(o.pendingReaps, key)
	}
}

// evictClient removes a client from the broadcast set, releases the
// connection's session ownership, and closes the conn. Safe to call multiple
// times. Releasing ownership is what arms the grace-windowed reap for any
// session whose last owning connection just disconnected — the mechanism that
// closes the orphaned-session FD leak.
func (s *Server) evictClient(conn net.Conn) {
	s.mu.Lock()
	cw, ok := s.clients[conn]
	if ok {
		delete(s.clients, conn)
	}
	s.mu.Unlock()
	if ok {
		if s.ownership != nil {
			s.ownership.releaseConn(conn)
		}
		select {
		case <-cw.done:
		default:
			close(cw.done)
		}
		if err := conn.Close(); err != nil {
			utils.Log("Server", fmt.Sprintf("removeClient: conn close failed: %v", err))
		}
	}
}
