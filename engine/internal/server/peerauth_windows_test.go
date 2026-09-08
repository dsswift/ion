//go:build windows

package server

import (
	"net"
	"os"
	"testing"
)

// The Windows-native half of the peer-authorization seam. These exercise the
// real syscalls -- the kernel connection table, OpenProcess, the token user --
// against a loopback connection this process makes to itself, so they need no
// second account and no fixture. Everything they assert is a property the
// cross-platform tests cannot reach.
//
// They run on a Windows host: the `engine-test-windows` job in
// .github/workflows/quality.yml, and any local `go test ./...` on the VM.

func TestCurrentProcessSIDIsAWellFormedSID(t *testing.T) {
	sid, err := currentProcessSID()
	if err != nil {
		t.Fatalf("currentProcessSID: %v", err)
	}
	if len(sid) < 6 || sid[:4] != "S-1-" {
		t.Fatalf("currentProcessSID returned %q, which is not a string SID", sid)
	}
}

func TestReadTCPTableReturnsRows(t *testing.T) {
	rows, err := readTCPTable()
	if err != nil {
		t.Fatalf("readTCPTable: %v", err)
	}
	// A Windows host with zero IPv4 TCP rows is possible in principle but the
	// listener opened by the next test guarantees at least one here.
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = ln.Close() }()
	rows, err = readTCPTable()
	if err != nil {
		t.Fatalf("readTCPTable after listen: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("the connection table is empty while this process holds a listener")
	}
}

// The end-to-end resolver: a connection this process makes to itself must
// resolve to this process's own pid and SID. If the four-tuple matching, the
// byte-order decode, or the token lookup is wrong, this fails.
func TestResolveWindowsPeerIdentifiesThisProcess(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = ln.Close() }()

	client, err := net.Dial("tcp4", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = client.Close() }()

	accepted, err := ln.Accept()
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	defer func() { _ = accepted.Close() }()

	id, err := resolveWindowsPeer(accepted.LocalAddr().(*net.TCPAddr), accepted.RemoteAddr().(*net.TCPAddr))
	if err != nil {
		t.Fatalf("resolveWindowsPeer: %v", err)
	}
	if id.PID != uint32(os.Getpid()) {
		t.Errorf("peer PID = %d, want this process (%d)", id.PID, os.Getpid())
	}
	self, err := currentProcessSID()
	if err != nil {
		t.Fatalf("currentProcessSID: %v", err)
	}
	if id.SID != self {
		t.Errorf("peer SID = %q, want this process's own %q", id.SID, self)
	}
}

// The production authorizer, built the way Start builds it, must admit a
// connection from this same process.
func TestLocalPeerAuthorizerAdmitsThisProcess(t *testing.T) {
	a, err := newLocalPeerAuthorizer()
	if err != nil {
		t.Fatalf("newLocalPeerAuthorizer: %v", err)
	}

	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = ln.Close() }()
	client, err := net.Dial("tcp4", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = client.Close() }()
	accepted, err := ln.Accept()
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	defer func() { _ = accepted.Close() }()

	if _, err := a.authorize(accepted); err != nil {
		t.Fatalf("the engine's own process was refused by its own authorizer: %v", err)
	}
}

// A peer that has gone away leaves no established row, and no row is a
// refusal. This is the fail-closed branch exercised against the real table
// rather than a stub.
func TestResolveWindowsPeerRefusesAClosedConnection(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = ln.Close() }()
	client, err := net.Dial("tcp4", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	accepted, err := ln.Accept()
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	local := accepted.LocalAddr().(*net.TCPAddr)
	remote := accepted.RemoteAddr().(*net.TCPAddr)
	if err := client.Close(); err != nil {
		t.Fatalf("close client: %v", err)
	}
	if err := accepted.Close(); err != nil {
		t.Fatalf("close accepted: %v", err)
	}

	if _, err := resolveWindowsPeer(local, remote); err == nil {
		t.Fatal("a closed connection still resolved to a peer identity")
	}
}
