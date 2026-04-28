package transport

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"sync"
	"testing"
	"time"
)

// shortSockPath creates a short Unix socket path under /tmp to avoid the
// 108-character limit on Unix socket paths.
func shortSockPath(t *testing.T, name string) string {
	t.Helper()
	path := fmt.Sprintf("/tmp/ion-test-%s-%d.sock", name, os.Getpid())
	t.Cleanup(func() { os.Remove(path) })
	os.Remove(path) // Remove stale socket if present.
	return path
}

func TestUnixTransport_ListenAndConnect(t *testing.T) {
	sockPath := shortSockPath(t, "listen")

	ut := NewUnixTransport(sockPath)

	var received []byte
	var mu sync.Mutex
	connCh := make(chan struct{}, 1)

	err := ut.Listen(func(conn Conn) {
		connCh <- struct{}{}
		// Read from the connection.
		// The unixConn wraps a net.Conn; we just test it connected.
	})
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ut.Close()

	// Connect a client.
	client, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer client.Close()

	// Wait for connection to be accepted.
	select {
	case <-connCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for connection")
	}

	// Broadcast a message.
	ut.Broadcast([]byte(`{"type":"test"}`))

	// Read from client.
	reader := bufio.NewReader(client)
	client.SetReadDeadline(time.Now().Add(2 * time.Second))
	line, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatalf("ReadBytes: %v", err)
	}

	mu.Lock()
	received = line
	mu.Unlock()

	if string(received) != "{\"type\":\"test\"}\n" {
		t.Errorf("expected broadcast message, got %q", string(received))
	}
}

func TestUnixTransport_BroadcastMultiple(t *testing.T) {
	sockPath := shortSockPath(t, "multi")

	ut := NewUnixTransport(sockPath)
	err := ut.Listen(func(conn Conn) {})
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ut.Close()

	// Connect two clients.
	c1, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("Dial c1: %v", err)
	}
	defer c1.Close()

	c2, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("Dial c2: %v", err)
	}
	defer c2.Close()

	// Give connections time to register.
	time.Sleep(50 * time.Millisecond)

	ut.Broadcast([]byte("hello"))

	for i, c := range []net.Conn{c1, c2} {
		reader := bufio.NewReader(c)
		c.SetReadDeadline(time.Now().Add(2 * time.Second))
		line, err := reader.ReadBytes('\n')
		if err != nil {
			t.Fatalf("client %d read: %v", i, err)
		}
		if string(line) != "hello\n" {
			t.Errorf("client %d: expected 'hello\\n', got %q", i, string(line))
		}
	}
}

func TestUnixTransport_Close(t *testing.T) {
	sockPath := shortSockPath(t, "close")

	ut := NewUnixTransport(sockPath)
	err := ut.Listen(func(conn Conn) {})
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}

	if err := ut.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Socket file should no longer accept connections.
	_, err = net.DialTimeout("unix", sockPath, 100*time.Millisecond)
	if err == nil {
		t.Error("expected connection to fail after close")
	}
}

func TestUnixTransport_Path(t *testing.T) {
	ut := NewUnixTransport("/tmp/test.sock")
	if ut.Path() != "/tmp/test.sock" {
		t.Errorf("expected /tmp/test.sock, got %q", ut.Path())
	}
}

func TestUnixTransport_CleanupSocket(t *testing.T) {
	sockPath := shortSockPath(t, "cleanup")

	ut := NewUnixTransport(sockPath)
	err := ut.Listen(func(conn Conn) {})
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	ut.Close()
}

func TestRelayTransport_New(t *testing.T) {
	rt := NewRelayTransport("wss://relay.example.com", "api-key-123", "chan-1")
	if rt == nil {
		t.Fatal("expected non-nil relay transport")
	}
	if rt.url != "wss://relay.example.com" {
		t.Errorf("expected URL, got %q", rt.url)
	}
	if rt.channelID != "chan-1" {
		t.Errorf("expected chan-1, got %q", rt.channelID)
	}
}

func TestRelayTransport_Close(t *testing.T) {
	rt := NewRelayTransport("wss://relay.example.com", "key", "chan")
	if err := rt.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Second close should not panic.
	if err := rt.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestRelayTransport_Listen(t *testing.T) {
	rt := NewRelayTransport("wss://relay.example.com", "key", "chan")
	// Listen with nil handler should not error (starts connect loop in background).
	err := rt.Listen(nil)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	rt.Close()
}

func TestRelayTransport_Broadcast(t *testing.T) {
	rt := NewRelayTransport("wss://relay.example.com", "key", "chan")
	defer rt.Close()

	// Broadcast is a no-op when not connected (no panic, no error).
	rt.Broadcast([]byte("test"))
}

func TestRelayTransport_OnMessage(t *testing.T) {
	rt := NewRelayTransport("wss://relay.example.com", "key", "chan")
	defer rt.Close()

	called := false
	rt.OnMessage = func(data []byte) {
		called = true
	}
	if rt.OnMessage == nil {
		t.Error("expected OnMessage to be set")
	}
	_ = called
}

func TestRelayTransport_InterfaceCompliance(t *testing.T) {
	var _ Transport = (*RelayTransport)(nil)
}
