package providers

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Error codes matching providers/errors.ts ProviderErrorCode.
const (
	ErrRateLimit     = "rate_limit"
	ErrOverloaded    = "overloaded"
	ErrPromptTooLong = "prompt_too_long"
	ErrAuth          = "auth"
	ErrNetwork       = "network"
	ErrStaleConn     = "stale_connection"
	ErrTimeout       = "timeout"
	ErrContentFilter = "content_filter"
	ErrInvalidModel  = "invalid_model"
	ErrInvalidReq    = "invalid_request"
	ErrMediaError    = "media_error"
	ErrPDFError         = "pdf_error"
	ErrStreamTruncated  = "stream_truncated"
	ErrUnknown          = "unknown"
)

// ProviderError is the canonical error type for all provider failures.
type ProviderError struct {
	Code         string `json:"code"`
	Message      string `json:"message"`
	HTTPStatus   int    `json:"httpStatus,omitempty"`
	Retryable    bool   `json:"retryable"`
	RetryAfterMs int64  `json:"retryAfterMs,omitempty"`
	Attempt      int    `json:"attempt,omitempty"`
	Cause        error  `json:"-"`
}

func (e *ProviderError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %s (cause: %v)", e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *ProviderError) Unwrap() error {
	return e.Cause
}

// NewProviderError creates a ProviderError with the given parameters.
func NewProviderError(code, message string, httpStatus int, retryable bool) *ProviderError {
	return &ProviderError{
		Code:       code,
		Message:    message,
		HTTPStatus: httpStatus,
		Retryable:  retryable,
	}
}

// FromAnthropicError classifies an HTTP error from the Anthropic API.
func FromAnthropicError(err error, status int, body string) *ProviderError {
	msg := err.Error()
	bodyLower := strings.ToLower(body)

	if status == 401 || status == 403 {
		return NewProviderError(ErrAuth, msg, status, false)
	}

	if status == 429 {
		pe := NewProviderError(ErrRateLimit, msg, 429, true)
		pe.RetryAfterMs = parseRetryAfterFromBody(body)
		return pe
	}

	if status == 529 || strings.Contains(bodyLower, "overloaded") {
		s := status
		if s == 0 {
			s = 529
		}
		return NewProviderError(ErrOverloaded, msg, s, true)
	}

	if status >= 500 {
		return NewProviderError(ErrOverloaded, msg, status, true)
	}

	if strings.Contains(msg, "ECONNRESET") || strings.Contains(msg, "EPIPE") ||
		strings.Contains(msg, "connection reset") {
		return &ProviderError{Code: ErrStaleConn, Message: msg, Retryable: true, Cause: err}
	}

	if strings.Contains(strings.ToLower(msg), "timeout") {
		return &ProviderError{Code: ErrTimeout, Message: msg, Retryable: true, Cause: err}
	}

	if strings.Contains(msg, "ECONNREFUSED") || strings.Contains(msg, "no such host") ||
		strings.Contains(strings.ToLower(msg), "fetch failed") {
		return &ProviderError{Code: ErrNetwork, Message: msg, Retryable: true, Cause: err}
	}

	if status == 400 {
		if strings.Contains(bodyLower, "too long") || strings.Contains(bodyLower, "too many tokens") ||
			strings.Contains(bodyLower, "context length") {
			return NewProviderError(ErrPromptTooLong, msg, 400, false)
		}
		if strings.Contains(bodyLower, "model") || strings.Contains(bodyLower, "not found") {
			return NewProviderError(ErrInvalidModel, msg, 400, false)
		}
		if strings.Contains(bodyLower, "pdf") || strings.Contains(bodyLower, "document") {
			return NewProviderError(ErrPDFError, msg, 400, false)
		}
		if strings.Contains(bodyLower, "image") || strings.Contains(bodyLower, "media") {
			return NewProviderError(ErrMediaError, msg, 400, false)
		}
		return NewProviderError(ErrInvalidReq, msg, 400, false)
	}

	pe := NewProviderError(ErrUnknown, msg, status, false)
	pe.Cause = err
	return pe
}

// FromOpenAIError classifies an HTTP error from the OpenAI API.
func FromOpenAIError(err error, status int, body string) *ProviderError {
	msg := err.Error()
	bodyLower := strings.ToLower(body)

	if status == 401 || status == 403 {
		return NewProviderError(ErrAuth, msg, status, false)
	}

	if status == 429 {
		pe := NewProviderError(ErrRateLimit, msg, 429, true)
		pe.RetryAfterMs = parseRetryAfterFromBody(body)
		return pe
	}

	if status >= 500 {
		return NewProviderError(ErrOverloaded, msg, status, true)
	}

	if strings.Contains(bodyLower, "content_filter") || strings.Contains(bodyLower, "content policy") {
		s := status
		if s == 0 {
			s = 400
		}
		return NewProviderError(ErrContentFilter, msg, s, false)
	}

	if strings.Contains(msg, "ECONNRESET") || strings.Contains(msg, "EPIPE") ||
		strings.Contains(msg, "connection reset") {
		return &ProviderError{Code: ErrStaleConn, Message: msg, Retryable: true, Cause: err}
	}

	if strings.Contains(strings.ToLower(msg), "timeout") {
		return &ProviderError{Code: ErrTimeout, Message: msg, Retryable: true, Cause: err}
	}

	if strings.Contains(msg, "ECONNREFUSED") || strings.Contains(msg, "no such host") ||
		strings.Contains(strings.ToLower(msg), "fetch failed") {
		return &ProviderError{Code: ErrNetwork, Message: msg, Retryable: true, Cause: err}
	}

	if status == 400 {
		if strings.Contains(bodyLower, "too long") || strings.Contains(bodyLower, "maximum context") ||
			strings.Contains(bodyLower, "tokens") {
			return NewProviderError(ErrPromptTooLong, msg, 400, false)
		}
		if strings.Contains(bodyLower, "model") || strings.Contains(bodyLower, "does not exist") {
			return NewProviderError(ErrInvalidModel, msg, 400, false)
		}
		if strings.Contains(bodyLower, "image") || strings.Contains(bodyLower, "media") {
			return NewProviderError(ErrMediaError, msg, 400, false)
		}
		return NewProviderError(ErrInvalidReq, msg, 400, false)
	}

	pe := NewProviderError(ErrUnknown, msg, status, false)
	pe.Cause = err
	return pe
}

// KeepAliveDisabled is set when a stale connection is detected.
// Providers should recreate HTTP clients when this is true.
var KeepAliveDisabled bool

// DisableKeepAlive sets the global keepalive-disabled flag.
func DisableKeepAlive() { KeepAliveDisabled = true }

// parseRetryAfterFromBody attempts to extract a retry-after hint from
// the JSON error body. Returns 0 if not found.
func parseRetryAfterFromBody(body string) int64 {
	var parsed struct {
		Error struct {
			RetryAfter float64 `json:"retry_after"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(body), &parsed) == nil && parsed.Error.RetryAfter > 0 {
		return int64(parsed.Error.RetryAfter * 1000)
	}
	return 0
}
