//go:build unix

// transport_unix.go — fd-1 hardening.
//
// The protocol owns stdout. Anything else that writes there — a forgotten
// fmt.Println, a cgo library's fprintf, a dependency's debug print — lands in
// the middle of a JSON-RPC frame and desynchronises the stream. The engine
// then drops the connection and the extension dies for a reason that looks
// nothing like its cause.
//
// The fix is to take stdout away from the process. Run dups fd 1 to a private
// descriptor the framing writer keeps, then dups stderr over fd 1. From that
// point "writing to stdout" writes to stderr, which the engine drains into its
// log, and only this package can reach the real frame stream.
package ion

import (
	"fmt"
	"os"
	"syscall"
)

// hardenStdout redirects fd 1 to stderr and rebinds the frame writer to a dup
// of the original stdout. A transport writing anywhere other than the process
// stdout (every test) has nothing to protect and is left alone.
func (t *transport) hardenStdout() error {
	if t.out != os.Stdout {
		return nil
	}

	// Duplicate the real stdout to a fresh descriptor. Dup gives the lowest
	// free fd; marking it close-on-exec keeps it out of any subprocess the
	// extension spawns, which would otherwise inherit a handle on the frame
	// stream and could write into it.
	dupFD, err := syscall.Dup(int(os.Stdout.Fd()))
	if err != nil {
		return fmt.Errorf("dup stdout: %w", err)
	}
	syscall.CloseOnExec(dupFD)

	// Point fd 1 at stderr. Stray writes now go somewhere harmless: the
	// engine drains the extension's stderr into ~/.ion/engine.jsonl.
	if err := syscall.Dup2(int(os.Stderr.Fd()), int(os.Stdout.Fd())); err != nil {
		if cerr := syscall.Close(dupFD); cerr != nil {
			return fmt.Errorf("redirect stdout to stderr: %w (and closing the dup failed: %v)", err, cerr)
		}
		return fmt.Errorf("redirect stdout to stderr: %w", err)
	}

	t.writeMu.Lock()
	t.out = os.NewFile(uintptr(dupFD), "ion-protocol-stdout")
	t.writeMu.Unlock()
	return nil
}
