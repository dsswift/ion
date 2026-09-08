//go:build windows

package main

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// userScopedPort returns a loopback port derived from the current user's
// SID, so two accounts signed in to the same machine never resolve to the
// same address.
//
// The engine listens on loopback TCP on Windows because Go has no native
// named-pipe listener. A single fixed port is safe for one interactive
// user, and wrong the moment there are two: on a shared workstation with
// fast user switching, or on an Azure Virtual Desktop multi-session host,
// the second user's engine cannot bind and their desktop connects to the
// FIRST user's engine instead.
//
// Deriving the port per user is an ADDRESSING decision, not an authorization
// one. It stops two engines colliding; it does not stop a second user from
// scanning the range and connecting to the port they find. That is what
// engine/internal/server/peerauth_windows.go is for. Do not describe this
// function as making cross-user connection impossible -- it does not.
//
// Derivation is deterministic so the address is stable across restarts
// without any coordination, file, or registry state: the same SID always
// produces the same port, and the desktop computes it independently rather
// than being told. A SID is the right input because it is unique per account
// per machine and, unlike a username, cannot be reused by a deleted-and-
// recreated account.
//
// There is no fallback. An unreadable SID returns an error, and every caller
// turns that into a refusal to start or dial. See resolveSocketPath.
//
// This is a default, not a policy: ION_SOCKET_PATH still overrides it
// outright, which is what a deployment with its own port plan uses.
func userScopedPort() (int, error) {
	sid, err := currentUserSID()
	if err != nil {
		return 0, fmt.Errorf("reading this process's token user: %w", err)
	}
	if sid == "" {
		return 0, fmt.Errorf("this process's token user resolved to an empty SID")
	}
	return derivePort(sid), nil
}

// currentUserSID returns the string SID of the process token's user.
func currentUserSID() (string, error) {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}
