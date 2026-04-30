package server

import (
	"bufio"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// TestBroadcastSlowClientDoesNotBlock verifies that one stalled consumer cannot
// block broadcast delivery to other clients or to the broadcast caller. The
// fast client must keep receiving events promptly, and the broadcast loop
// itself must return quickly even when one client never reads.
func TestBroadcastSlowClientDoesNotBlock(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	fast, err := net.Dial("unix", srv.SocketPath())
	if err != nil {
		t.Fatalf("dial fast: %v", err)
	}
	defer fast.Close()

	slow, err := net.Dial("unix", srv.SocketPath())
	if err != nil {
		t.Fatalf("dial slow: %v", err)
	}
	defer slow.Close()

	// Wait for the server to register both clients.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		srv.mu.RLock()
		n := len(srv.clients)
		srv.mu.RUnlock()
		if n >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Fast client drains in a goroutine, counting events.
	var received int64
	doneFast := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(fast)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			atomic.AddInt64(&received, 1)
		}
		close(doneFast)
	}()

	// Slow client never reads. Fill its queue + OS socket buffer with many
	// broadcasts, then verify the broadcast call returned quickly and the
	// fast client kept up.
	const events = broadcastQueueSize * 8
	const lineSize = 512
	payload := make([]byte, lineSize-1)
	for i := range payload {
		payload[i] = 'x'
	}
	line := string(payload) + "\n"

	start := time.Now()
	for i := 0; i < events; i++ {
		srv.broadcast(line)
	}
	elapsed := time.Since(start)

	if elapsed > 500*time.Millisecond {
		t.Fatalf("broadcast loop blocked on slow client: %v for %d events", elapsed, events)
	}

	// The broadcast queue is bounded, so under heavy spam some events drop on
	// both clients; the property we care about is that the fast reader is not
	// starved. Require it to have received a meaningful share within the
	// deadline (>= queue capacity proves the drainer kept progressing).
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt64(&received) >= int64(broadcastQueueSize) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := atomic.LoadInt64(&received); got < int64(broadcastQueueSize) {
		t.Fatalf("fast client received %d events; expected at least queue capacity %d -- drainer stalled", got, broadcastQueueSize)
	}
}

// TestBroadcastEvictsDeadClient verifies that a client whose socket has been
// abruptly closed is removed from the broadcast set after a write error, so
// we do not leak clientWriter goroutines.
func TestBroadcastEvictsDeadClient(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn, err := net.Dial("unix", srv.SocketPath())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	// Wait for registration.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		srv.mu.RLock()
		n := len(srv.clients)
		srv.mu.RUnlock()
		if n >= 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Force the client off the network. handleClient's defer will evict.
	conn.Close()

	// Server should observe the disconnect and remove the client.
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		srv.mu.RLock()
		n := len(srv.clients)
		srv.mu.RUnlock()
		if n == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	srv.mu.RLock()
	n := len(srv.clients)
	srv.mu.RUnlock()
	t.Fatalf("client not evicted after disconnect; clients=%d", n)
}

// TestOnBroadcastListenerIsolation verifies that a slow OnBroadcast listener
// does not stall delivery to other listeners or to socket clients.
func TestOnBroadcastListenerIsolation(t *testing.T) {
	mb := newMockBackend()
	dir, err := os.MkdirTemp("/tmp", "ion-iso-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sockPath := filepath.Join(dir, "t.sock")
	srv := NewServer(sockPath, mb)
	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })

	var fastCount int64
	gate := make(chan struct{})

	srv.OnBroadcast(func(line string) {
		<-gate // never receives, simulating a stalled listener
	})
	srv.OnBroadcast(func(line string) {
		atomic.AddInt64(&fastCount, 1)
	})

	const events = broadcastQueueSize * 4
	start := time.Now()
	for i := 0; i < events; i++ {
		srv.broadcast("event\n")
	}
	elapsed := time.Since(start)
	if elapsed > 500*time.Millisecond {
		t.Fatalf("broadcast blocked on slow listener: %v", elapsed)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt64(&fastCount) >= int64(broadcastQueueSize) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := atomic.LoadInt64(&fastCount); got < int64(broadcastQueueSize) {
		t.Fatalf("fast listener processed %d events; expected at least queue capacity %d -- slow listener stalled the path", got, broadcastQueueSize)
	}

	// Release the slow listener so its drain goroutine can exit at Stop.
	close(gate)
}
