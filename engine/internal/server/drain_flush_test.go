package server

import (
	"bufio"
	"net"
	"testing"
	"time"
)

// A state line queued at the moment the writer's done closes is still
// written: the shutdown command's result is enqueued and then the stop
// closes the writer, and the client must read the result, not a closed
// socket.
func TestDrainClientFlushesQueuedStateOnDone(t *testing.T) {
	// Not started: the drain needs the server only for eviction on a failed write.
	srv := NewServer("/tmp/unused-drain-flush.sock", newMockBackend())
	serverEnd, clientEnd := net.Pipe()
	defer clientEnd.Close()
	cw := newClientWriter("client-test", serverEnd, stateQueueSize)
	cw.stateQueue <- []byte("{\"cmd\":\"result\",\"requestId\":\"req-flush\",\"ok\":true}\n")
	close(cw.done)
	go srv.drainClient(cw)

	if err := clientEnd.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(clientEnd).ReadString('\n')
	if err != nil {
		t.Fatalf("client read the queued result: %v", err)
	}
	if line != "{\"cmd\":\"result\",\"requestId\":\"req-flush\",\"ok\":true}\n" {
		t.Fatalf("line = %q", line)
	}
	select {
	case <-cw.drained:
	case <-time.After(2 * time.Second):
		t.Fatal("drain did not report drained after writing the queued line")
	}
}
