//go:build windows

package server

import (
	"fmt"
	"net"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/dsswift/ion/engine/internal/utils"
)

// The Windows half of local-peer authorization: ask the kernel who owns the
// other end of an accepted loopback connection, then ask the OS who that
// process runs as.

var (
	modIphlpapi             = windows.NewLazySystemDLL("iphlpapi.dll")
	procGetExtendedTcpTable = modIphlpapi.NewProc("GetExtendedTcpTable")
)

const (
	// AF_INET. The listener binds tcp4, so the IPv6 table is never consulted.
	afInet = 2
	// TCP_TABLE_OWNER_PID_ALL: every connection, with its owning process id.
	tcpTableOwnerPIDAll = 5
	// PROCESS_QUERY_LIMITED_INFORMATION. Enough to open a token for identity,
	// and the least right that suffices -- PROCESS_QUERY_INFORMATION would
	// also work and asks for more than is needed.
	processQueryLimitedInformation = 0x1000
)

// mibTCPRowOwnerPID is MIB_TCPROW_OWNER_PID. Field order and width are fixed
// by the Windows header; every field is a DWORD.
type mibTCPRowOwnerPID struct {
	State      uint32
	LocalAddr  uint32
	LocalPort  uint32
	RemoteAddr uint32
	RemotePort uint32
	OwningPID  uint32
}

// tcpTableRetries is how many times the connection-table lookup is repeated
// before the peer is refused.
//
// The connection is ESTABLISHED by the time Accept returns, so the row is
// normally present on the first read. The retries cover the narrow window
// where GetExtendedTcpTable's snapshot was taken microseconds before the
// state transition landed. They do not cover a peer that has already exited:
// that peer stays absent, and an absent peer is a refusal.
const tcpTableRetries = 3

// tcpTableRetryDelay spaces those attempts. Small enough that a rejected
// connection is still rejected promptly, large enough to outlast a snapshot
// race.
const tcpTableRetryDelay = 10 * time.Millisecond

// readTCPTable returns the machine's IPv4 TCP connection table.
//
// The size is discovered by calling once with a zero-length buffer, which
// fails with ERROR_INSUFFICIENT_BUFFER and writes the required size. The
// table can grow between the two calls on a busy host, so the sizing call is
// retried rather than treated as fatal.
func readTCPTable() ([]tcpRow, error) {
	var buf []byte
	size := uint32(0)
	for attempt := 0; attempt < 4; attempt++ {
		var p *byte
		if len(buf) > 0 {
			p = &buf[0]
		}
		r0, _, _ := procGetExtendedTcpTable.Call(
			uintptr(unsafe.Pointer(p)),
			uintptr(unsafe.Pointer(&size)),
			0, // bOrder: no sorting needed, every row is scanned
			afInet,
			tcpTableOwnerPIDAll,
			0,
		)
		switch windows.Errno(r0) {
		case windows.ERROR_SUCCESS:
			return parseTCPTable(buf[:size])
		case windows.ERROR_INSUFFICIENT_BUFFER:
			// Overshoot slightly so a table that grows again between the
			// sizing call and the read still fits.
			buf = make([]byte, size+4096)
			size = uint32(len(buf))
		default:
			return nil, fmt.Errorf("GetExtendedTcpTable failed: %w", windows.Errno(r0))
		}
	}
	return nil, fmt.Errorf("GetExtendedTcpTable did not settle on a buffer size after 4 attempts")
}

// parseTCPTable decodes a MIB_TCPTABLE_OWNER_PID buffer: a DWORD row count
// followed by that many fixed-width rows.
func parseTCPTable(buf []byte) ([]tcpRow, error) {
	const header = 4
	rowSize := int(unsafe.Sizeof(mibTCPRowOwnerPID{}))
	if len(buf) < header {
		return nil, fmt.Errorf("connection table buffer is %d bytes, shorter than its header", len(buf))
	}
	count := int(*(*uint32)(unsafe.Pointer(&buf[0])))
	if need := header + count*rowSize; len(buf) < need {
		return nil, fmt.Errorf("connection table declares %d rows (%d bytes) but the buffer holds %d", count, need, len(buf))
	}
	rows := make([]tcpRow, 0, count)
	for i := 0; i < count; i++ {
		raw := (*mibTCPRowOwnerPID)(unsafe.Pointer(&buf[header+i*rowSize]))
		rows = append(rows, tcpRow{
			State:      tcpConnState(raw.State),
			LocalAddr:  decodeMibAddr(raw.LocalAddr),
			LocalPort:  decodeMibPort(raw.LocalPort),
			RemoteAddr: decodeMibAddr(raw.RemoteAddr),
			RemotePort: decodeMibPort(raw.RemotePort),
			OwningPID:  raw.OwningPID,
		})
	}
	return rows, nil
}

// processSID returns the token user of a process, as a string SID.
//
// Opening another user's process fails here with ERROR_ACCESS_DENIED, and
// that failure is the point: an engine running as one account cannot prove a
// connection from a different account belongs to it, so it refuses. The
// refusal is therefore correct on both the "different SID" path and the
// "cannot look" path.
func processSID(pid uint32) (string, error) {
	h, err := windows.OpenProcess(processQueryLimitedInformation, false, pid)
	if err != nil {
		return "", fmt.Errorf("OpenProcess(%d): %w", pid, err)
	}
	defer func() {
		if cerr := windows.CloseHandle(h); cerr != nil {
			// Nothing actionable, but a leaked handle in a long-lived daemon
			// is worth being able to see.
			logCloseHandleFailure(pid, cerr)
		}
	}()

	var token windows.Token
	if err := windows.OpenProcessToken(h, windows.TOKEN_QUERY, &token); err != nil {
		return "", fmt.Errorf("OpenProcessToken(%d): %w", pid, err)
	}
	defer func() {
		if cerr := token.Close(); cerr != nil {
			logCloseHandleFailure(pid, cerr)
		}
	}()

	user, err := token.GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("GetTokenUser(%d): %w", pid, err)
	}
	return user.User.Sid.String(), nil
}

// resolveWindowsPeer is the production peerResolver.
func resolveWindowsPeer(local, remote *net.TCPAddr) (peerIdentity, error) {
	var lastErr error
	for attempt := 0; attempt < tcpTableRetries; attempt++ {
		if attempt > 0 {
			time.Sleep(tcpTableRetryDelay)
		}
		rows, err := readTCPTable()
		if err != nil {
			lastErr = err
			continue
		}
		pid, err := findPeerOwnerPID(rows, local, remote)
		if err != nil {
			lastErr = err
			continue
		}
		sid, err := processSID(pid)
		if err != nil {
			// Not retried: an access-denied or exited process will not become
			// readable on the next pass, and retrying would only delay the
			// refusal.
			return peerIdentity{PID: pid}, err
		}
		return peerIdentity{PID: pid, SID: sid}, nil
	}
	return peerIdentity{}, fmt.Errorf("could not identify the peer of %s -> %s: %w", remote, local, lastErr)
}

// currentProcessSID returns the engine's own token user.
func currentProcessSID() (string, error) {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("GetTokenUser(self): %w", err)
	}
	return user.User.Sid.String(), nil
}

// newLocalPeerAuthorizer builds the production authorizer. An error here is
// fatal to Start: an engine that cannot name its own user cannot authorize
// anybody, and serving loopback TCP without that check on a multi-session
// host is the exposure this whole mechanism exists to close.
func newLocalPeerAuthorizer() (*localPeerAuthorizer, error) {
	sid, err := currentProcessSID()
	if err != nil {
		return nil, err
	}
	if sid == "" {
		return nil, fmt.Errorf("the engine's own token user resolved to an empty SID")
	}
	return &localPeerAuthorizer{selfSID: sid, resolve: resolveWindowsPeer}, nil
}

// logCloseHandleFailure records a handle that could not be released. Nothing
// can be done about it at the call site, but a daemon that leaks handles over
// weeks needs the failure to be visible somewhere.
func logCloseHandleFailure(pid uint32, err error) {
	utils.LogWithFields(utils.LevelDebug, "server", "peer authorization: closing a process handle failed", map[string]any{
		"peer_pid": pid,
		"error":    err.Error(),
	})
}
