package server

import (
	"net"
	"testing"
	"time"
)

// TestWriteToClientBlocksUntilSpace pins the result-delivery contract
// (dd79e162): writeToClient routes a line through the client's state queue and
// must BLOCK until there is space rather than dropping the line. Command
// results (start_session {ok:true}, etc.) flow through this path; dropping one
// left the desktop waiting 30s for a response that never arrived. The blocking
// select also has a done escape hatch so an evicted client cannot wedge the
// caller forever.
//
// Revert-test contract: reintroducing the non-blocking `default:` drop branch
// makes "delivered after space frees" go red — the line would be dropped
// instead of delivered once the queue is full.

// registerClientWithQueue installs a clientWriter for conn with a state queue
// of the given capacity, WITHOUT starting a drain goroutine, so the test fully
// controls when the queue drains.
func registerClientWithQueue(s *Server, conn net.Conn, stateCap int) *clientWriter {
	cw := &clientWriter{
		conn:        conn,
		stateQueue:  make(chan []byte, stateCap),
		streamQueue: make(chan []byte, streamQueueSize),
		done:        make(chan struct{}),
	}
	s.mu.Lock()
	s.clients[conn] = cw
	s.mu.Unlock()
	return cw
}

func TestWriteToClientBlocksUntilSpace(t *testing.T) {
	mb := newMockBackend()
	srv := NewServer("/tmp/unused-result-delivery.sock", mb)

	clientConn, _ := net.Pipe()
	defer clientConn.Close()

	// Size-1 state queue, pre-filled so it is full. No drain goroutine: the
	// test owns the queue.
	cw := registerClientWithQueue(srv, clientConn, 1)
	cw.stateQueue <- []byte("preexisting\n")

	// writeToClient must block (queue full) — it must NOT drop the line.
	delivered := make(chan struct{})
	go func() {
		srv.writeToClient(clientConn, "result-line\n")
		close(delivered)
	}()

	// Give the goroutine a chance to run; it must still be blocked because the
	// queue is full and nothing has drained.
	select {
	case <-delivered:
		t.Fatal("writeToClient returned while state queue was full — result was dropped, not queued")
	case <-time.After(50 * time.Millisecond):
		// Still blocked, as required.
	}

	// Drain one item → frees a slot → the blocked write must now land.
	got := <-cw.stateQueue
	if string(got) != "preexisting\n" {
		t.Fatalf("unexpected first queued line: %q", got)
	}

	select {
	case <-delivered:
		// writeToClient unblocked and queued the result.
	case <-time.After(time.Second):
		t.Fatal("writeToClient did not unblock after the queue drained")
	}

	// The result line is now in the queue (delivered, not dropped).
	select {
	case got := <-cw.stateQueue:
		if string(got) != "result-line\n" {
			t.Fatalf("expected result-line in queue, got %q", got)
		}
	default:
		t.Fatal("result-line was not queued after space freed")
	}
}

func TestWriteToClientUnblocksOnDone(t *testing.T) {
	mb := newMockBackend()
	srv := NewServer("/tmp/unused-result-delivery-done.sock", mb)

	clientConn, _ := net.Pipe()
	defer clientConn.Close()

	cw := registerClientWithQueue(srv, clientConn, 1)
	cw.stateQueue <- []byte("preexisting\n") // full

	returned := make(chan struct{})
	go func() {
		// Blocks because the queue is full.
		srv.writeToClient(clientConn, "doomed-line\n")
		close(returned)
	}()

	// Confirm it is blocked.
	select {
	case <-returned:
		t.Fatal("writeToClient returned before done was closed")
	case <-time.After(50 * time.Millisecond):
	}

	// Evicting the client closes done → the blocked write must return without
	// queueing (the slot was never freed).
	srv.evictClient(clientConn, "test_cleanup")

	select {
	case <-returned:
		// Unblocked via the done escape hatch — no deadlock.
	case <-time.After(time.Second):
		t.Fatal("writeToClient did not unblock when client was evicted")
	}
}
