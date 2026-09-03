package main

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// TestRunMcpBridge_RoundTrip pins the whole point of the bridge: bytes written to
// its stdin reach the Unix socket, and bytes the socket writes back reach its
// stdout. It also exercises the ordering that matters for MCP request/response —
// the bridge half-closes the socket write side on stdin EOF (so the server reads
// EOF and can respond) and still drains the response back to stdout afterward.
func TestRunMcpBridge_RoundTrip(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "bridge.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close() //nolint:errcheck // test listener cleanup

	var srvErr error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		conn, aerr := ln.Accept()
		if aerr != nil {
			srvErr = aerr
			return
		}
		defer conn.Close() //nolint:errcheck // test conn cleanup
		// Reads until the bridge half-closes on stdin EOF, proving stdin->socket.
		got, rerr := io.ReadAll(conn)
		if rerr != nil {
			srvErr = rerr
			return
		}
		if string(got) != "PING\n" {
			srvErr = fmt.Errorf("server received %q, want PING\\n", got)
			return
		}
		if _, werr := conn.Write([]byte("PONG\n")); werr != nil {
			srvErr = werr
		}
	}()

	out := &bytes.Buffer{}
	if err := runMcpBridge(sock, strings.NewReader("PING\n"), out, dialUnixSocket); err != nil {
		t.Fatalf("runMcpBridge: %v", err)
	}
	wg.Wait()
	if srvErr != nil {
		t.Fatalf("server side: %v", srvErr)
	}
	if out.String() != "PONG\n" {
		t.Errorf("bridge relayed stdout = %q, want PONG\\n (socket->stdout direction)", out.String())
	}
}

// TestRunMcpBridge_DialError pins that a bridge pointed at a nonexistent socket
// fails loudly (non-nil error) rather than hanging or exiting clean — the caller
// turns this into a stderr diagnostic and exit 1.
func TestRunMcpBridge_DialError(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "does-not-exist.sock")
	err := runMcpBridge(sock, strings.NewReader(""), &bytes.Buffer{}, dialUnixSocket)
	if err == nil {
		t.Fatal("expected a dial error for a nonexistent socket, got nil")
	}
}
