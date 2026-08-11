//go:build !unix

// transport_other.go — fd-1 hardening is a no-op off unix.
//
// The dup/dup2 pair in transport_unix.go has no portable equivalent here.
// The protocol still works; it just has no guard against a stray write to
// stdout, so extension authors on these platforms must be disciplined about
// using ctx.Log() rather than fmt.Print.
package ion

import "errors"

// errNoStdoutHardening is returned by hardenStdout on platforms with no dup2
// equivalent. Run logs it rather than failing, so the operator can see that
// the guard is absent instead of assuming it is in place.
var errNoStdoutHardening = errors.New("ion: stdout hardening is not supported on this platform")

// hardenStdout is not implemented on this platform. Returning an error rather
// than nil is deliberate: Run logs it, so the operator can see that the guard
// is absent instead of assuming it is in place.
func (t *transport) hardenStdout() error {
	return errNoStdoutHardening
}
