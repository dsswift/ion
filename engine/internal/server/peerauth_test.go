package server

import (
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

// The decision logic and the connection-table matching are platform-neutral
// so this file runs in the ordinary CI test pass on Linux and macOS, not only
// on a Windows host. The Windows-only syscall layer has its own file.

func tcpAddr(t *testing.T, s string) *net.TCPAddr {
	t.Helper()
	a, err := net.ResolveTCPAddr("tcp4", s)
	if err != nil {
		t.Fatalf("ResolveTCPAddr(%q): %v", s, err)
	}
	return a
}

// engineSID / otherSID are two accounts on one machine: the same domain,
// different RIDs. This is exactly the shape of an Azure Virtual Desktop
// multi-session host.
const (
	engineSID = "S-1-5-21-1696802954-1770460993-270566097-1000"
	otherSID  = "S-1-5-21-1696802954-1770460993-270566097-1001"
)

// fakeConn is the minimum net.Conn the authorizer touches: two addresses and
// a Close it records.
type peerFakeConn struct {
	net.Conn
	local  net.Addr
	remote net.Addr
	closed bool
}

func (c *peerFakeConn) LocalAddr() net.Addr  { return c.local }
func (c *peerFakeConn) RemoteAddr() net.Addr { return c.remote }
func (c *peerFakeConn) Close() error         { c.closed = true; return nil }

func loopbackConn(t *testing.T) *peerFakeConn {
	t.Helper()
	return &peerFakeConn{local: tcpAddr(t, "127.0.0.1:52700"), remote: tcpAddr(t, "127.0.0.1:61234")}
}

// The regression this whole mechanism exists for: a second interactive user
// on the same host connects to the engine's loopback port. Before local-peer
// authorization the connection was served; it must now be refused.
func TestAuthorizeRejectsADifferentUsersProcess(t *testing.T) {
	a := &localPeerAuthorizer{
		selfSID: engineSID,
		resolve: func(_, _ *net.TCPAddr) (peerIdentity, error) {
			return peerIdentity{PID: 4242, SID: otherSID}, nil
		},
	}
	id, err := a.authorize(loopbackConn(t))
	if err == nil {
		t.Fatal("a connection from another user's process was authorized")
	}
	if !errors.Is(err, errPeerUnauthorized) {
		t.Errorf("error is %v, want it to wrap errPeerUnauthorized so the log can say which refusal happened", err)
	}
	// The refused peer's identity still reaches the caller, because a log line
	// that cannot name who was refused is not an incident record.
	if id.PID != 4242 || id.SID != otherSID {
		t.Errorf("refusal lost the peer identity: %+v", id)
	}
}

func TestAuthorizeAdmitsTheEnginesOwnUser(t *testing.T) {
	a := &localPeerAuthorizer{
		selfSID: engineSID,
		resolve: func(_, _ *net.TCPAddr) (peerIdentity, error) {
			return peerIdentity{PID: 7, SID: engineSID}, nil
		},
	}
	id, err := a.authorize(loopbackConn(t))
	if err != nil {
		t.Fatalf("the engine's own desktop was refused: %v", err)
	}
	if id.PID != 7 {
		t.Errorf("PID = %d, want 7", id.PID)
	}
}

// Every way of failing to identify the peer is a refusal. This is the
// fail-closed property; a regression here reopens the hole silently, because
// an unidentifiable peer would simply be served.
func TestAuthorizeFailsClosed(t *testing.T) {
	cases := []struct {
		name string
		id   peerIdentity
		err  error
	}{
		{"no connection table row (peer already exited)", peerIdentity{}, errors.New("no established connection table row")},
		{"process token could not be opened (another account)", peerIdentity{PID: 9}, errors.New("OpenProcess(9): Access is denied.")},
		{"ambiguous table match", peerIdentity{}, errors.New("2 connection table rows match")},
		{"identity resolved with an empty SID", peerIdentity{PID: 9, SID: ""}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := &localPeerAuthorizer{
				selfSID: engineSID,
				resolve: func(_, _ *net.TCPAddr) (peerIdentity, error) { return tc.id, tc.err },
			}
			if _, err := a.authorize(loopbackConn(t)); err == nil {
				t.Fatal("connection was authorized despite an unresolvable peer identity")
			}
		})
	}
}

// A non-loopback peer should be unreachable on a 127.0.0.1 listener. The
// check is here because the design rests on that assumption, and it must not
// degrade into an admit if the bind address is ever widened by accident.
func TestAuthorizeRejectsANonLoopbackPeer(t *testing.T) {
	a := &localPeerAuthorizer{
		selfSID: engineSID,
		resolve: func(_, _ *net.TCPAddr) (peerIdentity, error) {
			t.Error("the resolver ran for a non-loopback peer; the address check should have refused first")
			return peerIdentity{SID: engineSID}, nil
		},
	}
	conn := &peerFakeConn{local: tcpAddr(t, "127.0.0.1:52700"), remote: tcpAddr(t, "10.1.2.3:61234")}
	if _, err := a.authorize(conn); err == nil {
		t.Fatal("a non-loopback peer was authorized")
	}
}

// A connection the authorizer cannot classify as TCP is refused rather than
// waved through -- the one branch where "we don't know" must not mean "yes".
func TestAuthorizeRejectsANonTCPConnection(t *testing.T) {
	a := &localPeerAuthorizer{selfSID: engineSID, resolve: func(_, _ *net.TCPAddr) (peerIdentity, error) {
		return peerIdentity{SID: engineSID}, nil
	}}
	conn := &peerFakeConn{local: &net.UnixAddr{Name: "/tmp/a.sock", Net: "unix"}, remote: &net.UnixAddr{Name: "@", Net: "unix"}}
	if _, err := a.authorize(conn); err == nil {
		t.Fatal("a non-TCP connection was authorized by the TCP peer authorizer")
	}
}

// authorizeAccepted is the accept-path wrapper: it must close a refused
// connection, and leave an accepted one open for the caller to serve.
func TestAuthorizeAcceptedClosesARefusedConnection(t *testing.T) {
	s := &Server{peerAuth: &localPeerAuthorizer{
		selfSID: engineSID,
		resolve: func(_, _ *net.TCPAddr) (peerIdentity, error) { return peerIdentity{PID: 1, SID: otherSID}, nil },
	}}
	conn := loopbackConn(t)
	if s.authorizeAccepted(conn) {
		t.Fatal("authorizeAccepted admitted another user's connection")
	}
	if !conn.closed {
		t.Error("a refused connection was left open")
	}
}

func TestAuthorizeAcceptedLeavesAnAuthorizedConnectionOpen(t *testing.T) {
	s := &Server{peerAuth: &localPeerAuthorizer{
		selfSID: engineSID,
		resolve: func(_, _ *net.TCPAddr) (peerIdentity, error) { return peerIdentity{PID: 1, SID: engineSID}, nil },
	}}
	conn := loopbackConn(t)
	if !s.authorizeAccepted(conn) {
		t.Fatal("authorizeAccepted refused the engine's own user")
	}
	if conn.closed {
		t.Error("an authorized connection was closed")
	}
}

// A nil authorizer is the Unix-socket and explicit-LAN case: the transport is
// already authorized by something else, so nothing is checked and nothing is
// closed.
func TestAuthorizeAcceptedIsATransparentPassWithNoAuthorizer(t *testing.T) {
	s := &Server{}
	conn := loopbackConn(t)
	if !s.authorizeAccepted(conn) {
		t.Fatal("a listener with no authorizer refused a connection")
	}
	if conn.closed {
		t.Error("a listener with no authorizer closed a connection")
	}
}

// installPeerAuthorization must not arm the check on a listen address the
// operator chose. A LAN or relay listener exists to serve other machines, and
// a same-user check there would refuse every peer it was set up for.
func TestInstallPeerAuthorizationSkipsAnOperatorChosenAddress(t *testing.T) {
	s := &Server{socketPath: "0.0.0.0:9000"}
	s.AllowUnauthenticatedPeers("ION_SOCKET_PATH is set")
	if err := s.installPeerAuthorization(); err != nil {
		t.Fatalf("installPeerAuthorization: %v", err)
	}
	if s.peerAuth != nil {
		t.Error("an operator-chosen LAN address was armed with same-user peer authorization")
	}
}

// A Unix socket is authorized by its path; there is nothing to install.
func TestInstallPeerAuthorizationSkipsAUnixSocket(t *testing.T) {
	s := &Server{socketPath: "/tmp/ion-test/engine.sock"}
	if err := s.installPeerAuthorization(); err != nil {
		t.Fatalf("installPeerAuthorization: %v", err)
	}
	if s.peerAuth != nil {
		t.Error("a Unix socket listener was armed with TCP peer authorization")
	}
}

// --- connection-table matching -------------------------------------------

func row(state tcpConnState, lip string, lport uint16, rip string, rport uint16, pid uint32) tcpRow {
	return tcpRow{
		State: state, LocalAddr: net.ParseIP(lip).To4(), LocalPort: lport,
		RemoteAddr: net.ParseIP(rip).To4(), RemotePort: rport, OwningPID: pid,
	}
}

func TestFindPeerOwnerPIDMatchesTheFullFourTuple(t *testing.T) {
	local := tcpAddr(t, "127.0.0.1:52700")  // the engine's listener
	remote := tcpAddr(t, "127.0.0.1:61234") // the peer

	rows := []tcpRow{
		// The engine's own accepted socket. Same ports, opposite direction --
		// matching this would report the engine as its own peer.
		row(tcpStateEstablished, "127.0.0.1", 52700, "127.0.0.1", 61234, 111),
		// A different process holding the same local port toward somewhere
		// else. Matching on the peer port alone would pick this one.
		row(tcpStateEstablished, "127.0.0.1", 61234, "127.0.0.1", 40000, 222),
		// The peer.
		row(tcpStateEstablished, "127.0.0.1", 61234, "127.0.0.1", 52700, 333),
	}
	pid, err := findPeerOwnerPID(rows, local, remote)
	if err != nil {
		t.Fatalf("findPeerOwnerPID: %v", err)
	}
	if pid != 333 {
		t.Errorf("owning PID = %d, want 333 (the row whose whole four-tuple matches)", pid)
	}
}

func TestFindPeerOwnerPIDIgnoresRowsThatAreNotEstablished(t *testing.T) {
	local := tcpAddr(t, "127.0.0.1:52700")
	remote := tcpAddr(t, "127.0.0.1:61234")
	// TIME_WAIT (11) left by a previous connection on the same port pair.
	rows := []tcpRow{row(11, "127.0.0.1", 61234, "127.0.0.1", 52700, 999)}
	if _, err := findPeerOwnerPID(rows, local, remote); err == nil {
		t.Fatal("a closing connection's row was accepted as the live peer")
	}
}

func TestFindPeerOwnerPIDRefusesAnAmbiguousMatch(t *testing.T) {
	local := tcpAddr(t, "127.0.0.1:52700")
	remote := tcpAddr(t, "127.0.0.1:61234")
	rows := []tcpRow{
		row(tcpStateEstablished, "127.0.0.1", 61234, "127.0.0.1", 52700, 1),
		row(tcpStateEstablished, "127.0.0.1", 61234, "127.0.0.1", 52700, 2),
	}
	_, err := findPeerOwnerPID(rows, local, remote)
	if err == nil {
		t.Fatal("two candidate peers were resolved to one")
	}
	if !strings.Contains(err.Error(), "ambiguous") {
		t.Errorf("error = %v, want it to name the ambiguity", err)
	}
}

func TestFindPeerOwnerPIDReportsNoMatch(t *testing.T) {
	local := tcpAddr(t, "127.0.0.1:52700")
	remote := tcpAddr(t, "127.0.0.1:61234")
	if _, err := findPeerOwnerPID(nil, local, remote); err == nil {
		t.Fatal("an empty connection table produced a peer")
	}
}

// The MIB port field is a DWORD whose low two bytes hold the port in network
// byte order. Reading it as a plain integer yields a number that looks like a
// port and matches nothing, so the decode is pinned by vectors.
func TestDecodeMibPort(t *testing.T) {
	for _, tc := range []struct {
		dw   uint32
		want uint16
	}{
		{0x38c7, 51000}, // 0xc738 -> 51000
		{0x1600, 22},
		{0x5000, 80},
		{0x0000, 0},
		{0xffff, 65535},
	} {
		if got := decodeMibPort(tc.dw); got != tc.want {
			t.Errorf("decodeMibPort(%#x) = %d, want %d", tc.dw, got, tc.want)
		}
	}
}

func TestDecodeMibAddr(t *testing.T) {
	// 127.0.0.1 as Windows stores it in a DWORD read little-endian.
	if got := decodeMibAddr(0x0100007f); !got.Equal(net.ParseIP("127.0.0.1")) {
		t.Errorf("decodeMibAddr(0x0100007f) = %v, want 127.0.0.1", got)
	}
	if got := decodeMibAddr(0x0f01a8c0); !got.Equal(net.ParseIP("192.168.1.15")) {
		t.Errorf("decodeMibAddr = %v, want 192.168.1.15", got)
	}
}

// End-to-end over a real listener: a refused peer must see its connection
// closed without a byte of protocol being served, and an admitted peer must
// be able to talk. This exercises the accept path rather than the predicate.
func TestAcceptLoopClosesAnUnauthorizedConnection(t *testing.T) {
	for _, tc := range []struct {
		name       string
		peerSID    string
		wantServed bool
	}{
		{"another user on the same host", otherSID, false},
		{"the engine's own desktop", engineSID, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ln, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatalf("listen: %v", err)
			}
			defer func() { _ = ln.Close() }()

			served := make(chan struct{}, 1)
			s := &Server{
				listener: ln,
				clients:  map[net.Conn]*clientWriter{},
				done:     make(chan struct{}),
				peerAuth: &localPeerAuthorizer{
					selfSID: engineSID,
					resolve: func(_, _ *net.TCPAddr) (peerIdentity, error) {
						return peerIdentity{PID: 1, SID: tc.peerSID}, nil
					},
				},
			}
			// A minimal accept loop with the same gate the server uses, so the
			// test pins the gate's placement rather than reimplementing it.
			go func() {
				for {
					conn, err := s.listener.Accept()
					if err != nil {
						return
					}
					if !s.authorizeAccepted(conn) {
						continue
					}
					served <- struct{}{}
					_, _ = fmt.Fprintln(conn, `{"ok":true}`)
				}
			}()

			c, err := net.Dial("tcp4", ln.Addr().String())
			if err != nil {
				t.Fatalf("dial: %v", err)
			}
			defer func() { _ = c.Close() }()

			select {
			case <-served:
				if !tc.wantServed {
					t.Fatal("an unauthorized connection reached the protocol handler")
				}
			case <-time.After(2 * time.Second):
				if tc.wantServed {
					t.Fatal("an authorized connection was never served")
				}
			}

			if !tc.wantServed {
				// The refused peer's read must end rather than hang: the
				// engine closed it.
				if err := c.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
					t.Fatalf("SetReadDeadline: %v", err)
				}
				buf := make([]byte, 1)
				if _, err := c.Read(buf); err == nil {
					t.Fatal("a refused peer read data from the engine")
				}
			}
		})
	}
}
