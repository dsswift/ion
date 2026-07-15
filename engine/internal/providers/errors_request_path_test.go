package providers

import (
	"errors"
	"testing"
)

// TestRequestPathTransportClassification pins that a transport-level error
// surfaced on the HTTP request path (client.Do returning an error with no HTTP
// status) is classified as a retryable stale_connection rather than collapsing
// into a non-retryable ErrUnknown.
//
// Regression: "use of closed network connection" was only recognized on the SSE
// read path via ClassifyTransportError. FromAnthropicError / FromOpenAIError —
// the functions the request path fell back to — did not match that string, so
// the error became ErrUnknown{Retryable:false} and WithRetry aborted the turn
// immediately instead of retrying the recycled connection.
func TestRequestPathTransportClassification(t *testing.T) {
	// Mirrors the net.OpError text Go produces when a request is issued over a
	// connection the transport has already closed.
	err := errors.New("write tcp 10.0.0.1:5000->1.2.3.4:443: use of closed network connection")

	t.Run("anthropic", func(t *testing.T) {
		pe := FromAnthropicError(err, 0, "")
		if pe == nil {
			t.Fatal("FromAnthropicError returned nil")
		}
		if !pe.Retryable {
			t.Errorf("expected Retryable=true, got false (code=%s)", pe.Code)
		}
		if pe.Code != ErrStaleConn {
			t.Errorf("expected code %q, got %q", ErrStaleConn, pe.Code)
		}
	})

	t.Run("openai", func(t *testing.T) {
		pe := FromOpenAIError(err, 0, "")
		if pe == nil {
			t.Fatal("FromOpenAIError returned nil")
		}
		if !pe.Retryable {
			t.Errorf("expected Retryable=true, got false (code=%s)", pe.Code)
		}
		if pe.Code != ErrStaleConn {
			t.Errorf("expected code %q, got %q", ErrStaleConn, pe.Code)
		}
	})

	// The direct classifier must agree — this is the shared source of truth the
	// request path now defers to.
	t.Run("classifier_directly", func(t *testing.T) {
		pe := ClassifyTransportError(err)
		if pe == nil {
			t.Fatal("ClassifyTransportError returned nil")
		}
		if !pe.Retryable || pe.Code != ErrStaleConn {
			t.Errorf("expected retryable stale_connection, got retryable=%v code=%s", pe.Retryable, pe.Code)
		}
	})

	// Guard: a real HTTP status must NOT be reinterpreted by the transport
	// classifier. A 429 body that happens to contain a transport-ish word stays
	// a rate_limit, because status != 0 bypasses ClassifyTransportError.
	t.Run("http_status_bypasses_transport_classifier", func(t *testing.T) {
		pe := FromAnthropicError(errors.New("anthropic API error"), 429, `{"error":{"type":"rate_limit"}}`)
		if pe.Code != ErrRateLimit {
			t.Errorf("expected code %q for 429, got %q", ErrRateLimit, pe.Code)
		}
	})
}
