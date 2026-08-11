// errors.go — the SDK's error surface.
//
// The protocol has no version negotiation, and by design: adding one would
// make every engine and every extension carry a compatibility matrix. The
// contract is additive instead — new methods appear, old ones never change
// shape — and a client discovers what an engine supports by calling and
// handling -32601.
//
// That makes [ErrMethodNotFound] the load-bearing error of this package. An
// extension that wants to run against older engine builds checks for it and
// degrades:
//
//	usage, err := ctx.GetContextUsage(c)
//	switch {
//	case errors.Is(err, ion.ErrMethodNotFound):
//		// engine predates ext/get_context_usage; carry on without it
//	case err != nil:
//		return err
//	}
package ion

import (
	"errors"
	"fmt"
)

// JSON-RPC 2.0 error codes used on this wire.
const (
	// CodeParseError: the peer could not parse a frame.
	CodeParseError = -32700
	// CodeInvalidRequest: the frame was not a valid request.
	CodeInvalidRequest = -32600
	// CodeMethodNotFound: the peer does not implement the method. From the
	// engine this means "this build lacks that capability" — degrade, do not
	// fail.
	CodeMethodNotFound = -32601
	// CodeInvalidParams: the params did not match the method.
	CodeInvalidParams = -32602
	// CodeInternalError: the handler panicked or failed unexpectedly.
	CodeInternalError = -32603
	// CodeHandlerError is the engine's code for a handler-reported failure
	// (an ext/* method whose wired capability returned an error).
	CodeHandlerError = -32000
)

// ErrMethodNotFound is returned when the engine answers -32601. Match it with
// errors.Is to implement graceful degradation against older engines.
var ErrMethodNotFound = errors.New("ion: engine does not implement this method")

// ErrClosed is returned by an in-flight call when the transport shuts down,
// which normally means the engine closed stdin.
var ErrClosed = errors.New("ion: connection closed")

// RPCError is a JSON-RPC error object returned by the engine.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("ion: rpc error %d: %s", e.Code, e.Message)
}

// Is reports RPCError{Code: -32601} as ErrMethodNotFound so callers can write
// errors.Is(err, ion.ErrMethodNotFound) without unwrapping the concrete type.
func (e *RPCError) Is(target error) bool {
	if target == ErrMethodNotFound {
		return e.Code == CodeMethodNotFound
	}
	return false
}
