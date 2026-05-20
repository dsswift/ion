package providers

import (
	"errors"
	"io"
	"strings"
	"testing"
)

// errReader yields some data then returns an error.
type errReader struct {
	data []byte
	pos  int
	err  error
}

func (r *errReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, r.err
	}
	n := copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}

// TestParseSSEStreamSurfacesReaderError verifies that a mid-stream read failure
// is exposed via the errFn instead of being silently swallowed (the historical
// bug that made every transport drop look like a synthetic "stream_truncated").
func TestParseSSEStreamSurfacesReaderError(t *testing.T) {
	partial := "event: message_start\ndata: {\"type\":\"message_start\"}\n\n" +
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\""
	reader := &errReader{
		data: []byte(partial),
		err:  io.ErrUnexpectedEOF,
	}

	ch, errFn := ParseSSEStream(reader)

	var collected []SSEEvent
	for ev := range ch {
		collected = append(collected, ev)
	}

	if len(collected) == 0 {
		t.Fatal("expected at least one event before truncation")
	}
	if collected[0].Event != "message_start" {
		t.Errorf("first event = %q, want message_start", collected[0].Event)
	}

	err := errFn()
	if err == nil {
		t.Fatal("expected non-nil error from errFn after truncated read")
	}
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Errorf("err = %v, want io.ErrUnexpectedEOF", err)
	}
}

// TestParseSSEStreamCleanEOFReturnsNilError verifies that a normal end-of-stream
// (clean EOF after the last event) returns nil from errFn.
func TestParseSSEStreamCleanEOFReturnsNilError(t *testing.T) {
	input := "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	ch, errFn := ParseSSEStream(strings.NewReader(input))

	for range ch {
	}

	if err := errFn(); err != nil {
		t.Errorf("clean EOF should return nil error, got %v", err)
	}
}

// TestAnthropicStreamErrorMapping verifies the SSE `event: error` payloads
// Anthropic emits mid-stream (overloaded, rate-limit, auth) classify to the
// right ProviderError. Without this mapping, the engine misreads upstream
// overload as a generic stream_truncated and burns through retries.
func TestAnthropicStreamErrorMapping(t *testing.T) {
	tests := []struct {
		name      string
		errType   string
		wantCode  string
		retryable bool
	}{
		{"overloaded", "overloaded_error", ErrOverloaded, true},
		{"rate_limit", "rate_limit_error", ErrRateLimit, true},
		{"api_error", "api_error", ErrOverloaded, true},
		{"timeout", "timeout_error", ErrOverloaded, true},
		{"auth", "authentication_error", ErrAuth, false},
		{"permission", "permission_error", ErrAuth, false},
		{"invalid_req", "invalid_request_error", ErrInvalidReq, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			se := &anthropicStreamError{RequestID: "req_test"}
			se.Error.Type = tt.errType
			se.Error.Message = "boom"
			pe := se.toProviderError()
			if pe == nil {
				t.Fatal("expected ProviderError")
			}
			if pe.Code != tt.wantCode {
				t.Errorf("code = %q, want %q", pe.Code, tt.wantCode)
			}
			if pe.Retryable != tt.retryable {
				t.Errorf("retryable = %v, want %v", pe.Retryable, tt.retryable)
			}
			if !strings.Contains(pe.Message, "req_test") {
				t.Errorf("message %q should include request_id", pe.Message)
			}
		})
	}
}

// TestClassifyTransportError covers the transport-failure patterns that show
// up when an LLM SSE connection silently drops (NAT idle, proxy reset, h2 PING
// miss). Each must map to a retryable code so WithRetry can recover.
func TestClassifyTransportError(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		wantCode  string
		retryable bool
	}{
		{"nil", nil, "", false},
		{"unexpected EOF", io.ErrUnexpectedEOF, ErrStaleConn, true},
		{"io.EOF", io.EOF, ErrStaleConn, true},
		{"connection reset", errors.New("read tcp 1.2.3.4: connection reset by peer"), ErrStaleConn, true},
		{"ECONNRESET", errors.New("ECONNRESET"), ErrStaleConn, true},
		{"broken pipe", errors.New("write tcp: broken pipe"), ErrStaleConn, true},
		{"http2 client lost", errors.New("http2: client connection lost"), ErrStaleConn, true},
		{"http2 stream reset", errors.New("http2: stream reset"), ErrStaleConn, true},
		{"http2 goaway", errors.New("http2: server sent GOAWAY and closed the connection"), ErrStaleConn, true},
		{"i/o timeout", errors.New("read tcp: i/o timeout"), ErrTimeout, true},
		{"deadline exceeded", errors.New("context deadline exceeded"), ErrTimeout, true},
		{"ECONNREFUSED", errors.New("dial tcp: ECONNREFUSED"), ErrNetwork, true},
		{"no such host", errors.New("lookup api.example.com: no such host"), ErrNetwork, true},
		{"no route", errors.New("dial: no route to host"), ErrNetwork, true},
		{"unrelated", errors.New("some validation failed"), "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pe := ClassifyTransportError(tt.err)
			if tt.wantCode == "" {
				if pe != nil {
					t.Fatalf("expected nil, got %+v", pe)
				}
				return
			}
			if pe == nil {
				t.Fatalf("expected ProviderError, got nil")
			}
			if pe.Code != tt.wantCode {
				t.Errorf("code = %q, want %q", pe.Code, tt.wantCode)
			}
			if pe.Retryable != tt.retryable {
				t.Errorf("retryable = %v, want %v", pe.Retryable, tt.retryable)
			}
			if pe.Cause == nil {
				t.Error("Cause should preserve the original error")
			}
		})
	}
}
