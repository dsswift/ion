package main

import (
	"crypto/sha256"
	"encoding/binary"
)

// The port range the per-user engine port is drawn from. It sits inside
// IANA's dynamic/private range (49152-65535), which no registered service may
// claim.
const (
	portRangeStart = 51000
	portRangeSize  = 4000
)

// derivePort maps a stable per-user identifier to a loopback port.
//
// Deterministic so the address needs no coordination, no file and no registry
// state: the same identifier always yields the same port, and the desktop
// computes it independently rather than being told. Kept platform-neutral so
// its vectors are testable on every OS, and mirrored by userScopedPort() in
// desktop/src/main/engine-address.ts.
func derivePort(id string) int {
	sum := sha256.Sum256([]byte(id))
	return portRangeStart + int(binary.BigEndian.Uint32(sum[:4])%portRangeSize)
}
