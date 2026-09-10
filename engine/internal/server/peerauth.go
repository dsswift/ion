package server

import (
	"errors"
	"fmt"
	"net"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Local-peer authorization for the Windows loopback transport.
//
// On every platform except Windows the engine listens on a Unix domain socket
// inside the user's own data directory, and the filesystem is the
// authorization: another account cannot open the socket because it cannot
// read the path. Windows has no such listener in Go, so the engine listens on
// loopback TCP -- and loopback TCP has no owner. Every interactive user on a
// multi-session host (Azure Virtual Desktop, a Remote Desktop Session Host,
// or plain fast user switching) can reach every other user's listener.
//
// A per-user port does NOT fix that. Deriving the port from the SID stops two
// engines from colliding on one port; it does not stop a second user from
// scanning 51000-54999 and connecting to the port they find. The port is an
// addressing decision. This file is the authorization.
//
// The mechanism is the most precise one Windows offers for a loopback peer:
// the connection's four-tuple is looked up in the kernel's TCP table to get
// the owning process id, that process's token is opened, and its user SID is
// compared to the engine's own. An OS-verified identity, not a secret the
// peer presents.
//
// Two properties follow from choosing it over the alternatives:
//
//   - The published NDJSON contract does not change. There is no handshake,
//     no token, no new first line. Every existing client -- the desktop, `ion
//     rpc`, a third-party script, an MCP bridge -- keeps working unmodified,
//     because it already runs as the user who owns the engine. A shared-secret
//     handshake would have broken all of them and forced a credential file
//     that is itself only as good as its ACL.
//   - It fails closed. Anything that prevents proving the peer is us -- an
//     absent table row, a process that exited, a token that cannot be opened
//     (which is exactly what happens when the peer belongs to another user) --
//     is a rejection, not a pass.

// peerIdentity is what the OS says about the process on the other end of an
// accepted connection.
type peerIdentity struct {
	// PID is the owning process id from the kernel's TCP table.
	PID uint32
	// SID is that process's token user, in string form ("S-1-5-21-...").
	SID string
}

// peerResolver maps an accepted connection's address pair to the identity of
// the process that opened it. local is the engine's side of the connection,
// remote is the peer's. Returns an error whenever the identity cannot be
// established for any reason -- the caller treats every error as a rejection.
type peerResolver func(local, remote *net.TCPAddr) (peerIdentity, error)

// errPeerUnauthorized is returned when the peer was identified and is not us.
// Distinguished from an unresolvable peer so the log says which happened:
// "another account connected" and "we could not tell who connected" are
// different operational events even though both end the connection.
var errPeerUnauthorized = errors.New("peer belongs to a different user")

// localPeerAuthorizer decides whether an accepted connection may proceed.
// Nil on every listener that does not need it (Unix sockets, and an explicit
// LAN/relay TCP listener the operator asked for), so the accept path pays
// nothing where the transport is already authorized.
type localPeerAuthorizer struct {
	// selfSID is the engine process's own token user. Resolved once at
	// startup: it cannot change for the life of the process.
	selfSID string
	// resolve is the platform lookup. Injected so the decision logic below is
	// testable on any OS.
	resolve peerResolver
}

// authorize reports whether conn may be served.
//
// A non-TCP connection reaching an authorizer is a programming error rather
// than an attack, but it is still refused: the authorizer exists precisely
// because this transport has no other owner check, and silently admitting a
// connection it cannot classify would be the fail-open branch this whole file
// is written to avoid.
func (a *localPeerAuthorizer) authorize(conn net.Conn) (peerIdentity, error) {
	local, lok := conn.LocalAddr().(*net.TCPAddr)
	remote, rok := conn.RemoteAddr().(*net.TCPAddr)
	if !lok || !rok {
		return peerIdentity{}, fmt.Errorf("connection is not TCP (local=%T remote=%T)", conn.LocalAddr(), conn.RemoteAddr())
	}
	// The listener binds 127.0.0.1, so a non-loopback peer should be
	// unreachable. Checked anyway: this is the assumption the whole design
	// rests on, and an assumption worth stating is worth enforcing.
	if !remote.IP.IsLoopback() {
		return peerIdentity{}, fmt.Errorf("peer %s is not on loopback", remote.IP)
	}

	id, err := a.resolve(local, remote)
	if err != nil {
		return peerIdentity{}, err
	}
	if id.SID == "" {
		return id, errors.New("peer identity resolved with an empty SID")
	}
	// Windows SIDs are case-insensitive in text form, but every producer here
	// (ConvertSidToStringSid) emits the same canonical uppercase form, so an
	// exact comparison is correct and a case-folding compare would only hide a
	// producer that had started disagreeing.
	if id.SID != a.selfSID {
		return id, fmt.Errorf("%w (peer=%s engine=%s)", errPeerUnauthorized, id.SID, a.selfSID)
	}
	return id, nil
}

// authorizeAccepted applies the authorizer to a freshly accepted connection,
// logs the outcome on both branches, and closes the connection on refusal.
// Returns true when the caller should go on to serve conn.
//
// A nil authorizer admits everything: that is the Unix-socket and explicit-LAN
// case, where this file's problem does not exist.
func (s *Server) authorizeAccepted(conn net.Conn) bool {
	a := s.peerAuth
	if a == nil {
		return true
	}
	id, err := a.authorize(conn)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server", "rejected a local client: peer authorization failed", map[string]any{
			"remote_address": conn.RemoteAddr().String(),
			"local_address":  conn.LocalAddr().String(),
			"peer_pid":       id.PID,
			"peer_sid":       id.SID,
			"engine_sid":     a.selfSID,
			"unauthorized":   errors.Is(err, errPeerUnauthorized),
			"error":          err.Error(),
		})
		if cerr := conn.Close(); cerr != nil {
			utils.LogWithFields(utils.LevelDebug, "server", "close of a rejected client failed", map[string]any{"error": cerr.Error()})
		}
		return false
	}
	utils.LogWithFields(utils.LevelDebug, "server", "local peer authorized", map[string]any{
		"remote_address": conn.RemoteAddr().String(),
		"peer_pid":       id.PID,
		"peer_sid":       id.SID,
	})
	return true
}
