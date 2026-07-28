//go:build !windows

package server

import (
	"net"
	"path/filepath"
	"syscall"
	"testing"
)

// TestSetSocketBuffers asserts the setsockopt calls behind tuneSocketBuffer
// actually take effect on an accepted connection. Before the per-platform
// split this code path had no test at all, which is how a call that did not
// compile for GOOS=windows reached a release build.
//
// The assertion is >= socketBufferSize rather than == because kernels round the
// requested value up and Linux reports back double what was requested (it
// accounts for its own bookkeeping overhead). An exact-equality assert would
// fail on a correct implementation.
func TestSetSocketBuffers(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "sockbuf.sock")

	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close() //nolint:errcheck // test cleanup

	accepted := make(chan net.Conn, 1)
	acceptErr := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			acceptErr <- err
			return
		}
		accepted <- conn
	}()

	client, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close() //nolint:errcheck // test cleanup

	var server net.Conn
	select {
	case server = <-accepted:
	case err := <-acceptErr:
		t.Fatalf("accept: %v", err)
	}
	defer server.Close() //nolint:errcheck // test cleanup

	sc, ok := server.(syscall.Conn)
	if !ok {
		t.Fatalf("accepted conn %T does not implement syscall.Conn", server)
	}
	raw, err := sc.SyscallConn()
	if err != nil {
		t.Fatalf("SyscallConn: %v", err)
	}

	var (
		setBufErr error
		sndBuf    int
		rcvBuf    int
		readErr   error
	)
	if err := raw.Control(func(fd uintptr) {
		setBufErr = setSocketBuffers(fd, socketBufferSize)
		if setBufErr != nil {
			return
		}
		sndBuf, readErr = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_SNDBUF)
		if readErr != nil {
			return
		}
		rcvBuf, readErr = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF)
	}); err != nil {
		t.Fatalf("raw.Control: %v", err)
	}

	if setBufErr != nil {
		t.Fatalf("setSocketBuffers: %v", setBufErr)
	}
	if readErr != nil {
		t.Fatalf("GetsockoptInt: %v", readErr)
	}
	if sndBuf < socketBufferSize {
		t.Errorf("SO_SNDBUF = %d, want >= %d", sndBuf, socketBufferSize)
	}
	if rcvBuf < socketBufferSize {
		t.Errorf("SO_RCVBUF = %d, want >= %d", rcvBuf, socketBufferSize)
	}
}
