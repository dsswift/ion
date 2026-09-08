package server

import (
	"fmt"
	"net"
)

// The connection-table matching half of local-peer authorization, kept
// platform-neutral so it is exercised by the normal test run on every OS
// rather than only on a Windows host. The Windows file supplies the rows; the
// rules for picking the right one out of them live here.

// tcpConnState mirrors the MIB_TCP_STATE values this code cares about.
type tcpConnState uint32

// tcpStateEstablished is MIB_TCP_STATE_ESTAB. A row in any other state is a
// connection that is closing or already closed: matching one would attribute
// a live connection to whatever process last used the same port pair, which
// is precisely the confusion this lookup exists to avoid.
const tcpStateEstablished tcpConnState = 5

// tcpRow is one MIB_TCPROW_OWNER_PID, decoded into host order.
type tcpRow struct {
	State      tcpConnState
	LocalAddr  net.IP
	LocalPort  uint16
	RemoteAddr net.IP
	RemotePort uint16
	OwningPID  uint32
}

// findPeerOwnerPID returns the process id that owns the peer's end of a
// connection the engine has just accepted.
//
// The engine's own view is inverted relative to the peer's row: what the
// engine calls the remote address is the peer's local address, and vice
// versa. Both ends of the four-tuple are matched, not just the peer's port,
// because a single port number is ambiguous -- two processes may each hold a
// loopback socket on the same local port toward different destinations, and
// admitting the wrong one would be an authorization bypass rather than a
// cosmetic mismatch.
//
// An error is returned when zero rows match and when more than one does.
// Ambiguity is a rejection: the caller cannot be told "one of these two
// processes" and still claim to have authorized anybody.
func findPeerOwnerPID(rows []tcpRow, local, remote *net.TCPAddr) (uint32, error) {
	var found []tcpRow
	for _, r := range rows {
		if r.State != tcpStateEstablished {
			continue
		}
		if int(r.LocalPort) != remote.Port || int(r.RemotePort) != local.Port {
			continue
		}
		if !r.LocalAddr.Equal(remote.IP) || !r.RemoteAddr.Equal(local.IP) {
			continue
		}
		found = append(found, r)
	}
	switch len(found) {
	case 1:
		return found[0].OwningPID, nil
	case 0:
		return 0, fmt.Errorf("no established connection table row for %s -> %s", remote, local)
	default:
		return 0, fmt.Errorf("%d connection table rows match %s -> %s; peer is ambiguous", len(found), remote, local)
	}
}

// decodeMibPort converts the DWORD port field of a MIB_TCPROW_OWNER_PID to a
// host-order port.
//
// Windows stores the port in the low two bytes of the DWORD in NETWORK byte
// order while the DWORD itself is read in host (little-endian) order, so the
// two bytes arrive swapped relative to the number they represent. Reading the
// field as a plain integer yields 46341 for port 51000 -- a value that looks
// like a port and matches nothing.
func decodeMibPort(dw uint32) uint16 {
	return uint16(dw&0xff)<<8 | uint16((dw>>8)&0xff)
}

// decodeMibAddr converts the DWORD address field of a MIB_TCPROW_OWNER_PID to
// an IPv4 address. The field is already in network byte order, which is the
// order net.IP stores, so the four bytes are taken lowest-first.
func decodeMibAddr(dw uint32) net.IP {
	return net.IPv4(byte(dw), byte(dw>>8), byte(dw>>16), byte(dw>>24))
}
