//go:build !windows

package server

import "errors"

// Off Windows the engine's default listener is a Unix domain socket inside
// the user's own data directory, so the filesystem already answers "may this
// peer connect". There is no loopback-TCP-without-an-owner problem to solve
// and therefore no authorizer to build.
//
// This returns an error rather than a nil authorizer so that a caller which
// asks for one on the wrong platform fails loudly. Start never asks: it
// builds an authorizer only for a Windows default listener.
func newLocalPeerAuthorizer() (*localPeerAuthorizer, error) {
	return nil, errors.New("local peer authorization is Windows-only; other platforms authorize by Unix socket path")
}
