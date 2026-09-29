package providers

import (
	"context"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestAuthRejectionSelfHealsOnce pins R-19/R-30: a single 401 invalidates the
// principal's cached state and retries exactly once, succeeding on the
// second attempt. This is a regression test for the self-heal branch: it
// fails (returns the auth error without a second attempt) against code that
// treats ErrAuth as purely non-retryable with no self-heal.
func TestAuthRejectionSelfHealsOnce(t *testing.T) {
	authErr := &ProviderError{Code: ErrAuth, Message: "unauthorized", HTTPStatus: 401, Retryable: false}
	provider := &midStreamFailProvider{
		id:               "test-prov",
		failCount:        1,
		failErr:          authErr,
		eventsBeforeFail: nil,
		successEvents:    []types.LlmStreamEvent{{Type: "message_stop"}},
	}

	attachCalls := 0
	cfg := &RetryConfig{
		Subject: "alice",
		AttachAuth: func(ctx context.Context, providerID string) context.Context {
			attachCalls++
			return ctx
		},
	}

	events, errc := WithRetry(context.Background(), provider, types.LlmStreamOptions{Model: "test-model"}, cfg)

	var lastEvent types.LlmStreamEvent
	for ev := range events {
		lastEvent = ev
	}
	err := <-errc
	if err != nil {
		t.Fatalf("expected the self-heal retry to succeed, got error: %v", err)
	}
	if lastEvent.Type != "message_stop" {
		t.Fatalf("expected the retried stream to complete, last event = %q", lastEvent.Type)
	}
	if provider.callCount != 2 {
		t.Fatalf("expected exactly 2 attempts (1 failure + 1 self-healed retry), got %d", provider.callCount)
	}
	// AttachAuth is called once per attempt already (the pre-existing
	// per-attempt re-resolution); the self-heal retry goes through the same
	// loop iteration, so it is called again on the second attempt too.
	if attachCalls < 2 {
		t.Errorf("expected AttachAuth to be called again on the self-healed retry, got %d calls", attachCalls)
	}
}

// TestAuthRejectionDoesNotLoop pins R-19: a PERSISTENT 401 self-heals once
// and then terminates -- it must never retry a second time for the same
// rejection, which would turn a one-shot self-heal into an unbounded loop.
func TestAuthRejectionDoesNotLoop(t *testing.T) {
	authErr := &ProviderError{Code: ErrAuth, Message: "unauthorized", HTTPStatus: 401, Retryable: false}
	provider := &midStreamFailProvider{
		id:        "test-prov",
		failCount: 1000, // always fails -- proves the loop terminates on its own
		failErr:   authErr,
	}

	cfg := &RetryConfig{
		Subject: "alice",
		AttachAuth: func(ctx context.Context, providerID string) context.Context {
			return ctx
		},
	}

	done := make(chan *ProviderError, 1)
	go func() {
		events, errc := WithRetry(context.Background(), provider, types.LlmStreamOptions{Model: "test-model"}, cfg)
		for range events {
		}
		err := <-errc
		pe, _ := err.(*ProviderError)
		done <- pe
	}()

	select {
	case pe := <-done:
		if pe == nil || pe.Code != ErrAuth {
			t.Fatalf("expected a terminal ErrAuth, got %+v", pe)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("WithRetry did not terminate -- the auth self-heal is looping")
	}

	if provider.callCount != 2 {
		t.Fatalf("expected exactly 2 attempts (1 failure + 1 self-healed retry, then stop), got %d", provider.callCount)
	}
}

// TestAuthRejectionExcludesPrincipalRefusal pins that a
// principal_credential_unresolved refusal (child 04) is NOT self-healed:
// invalidating and re-resolving a principal the fall-through policy already
// refused cannot produce a different answer, so it must fail immediately
// with no wasted retry.
func TestAuthRejectionExcludesPrincipalRefusal(t *testing.T) {
	refusalErr := NewPrincipalCredentialError("test-prov", "alice")
	provider := &midStreamFailProvider{
		id:        "test-prov",
		failCount: 1000,
		failErr:   refusalErr,
	}

	cfg := &RetryConfig{
		Subject: "alice",
		AttachAuth: func(ctx context.Context, providerID string) context.Context {
			return ctx
		},
	}

	events, errc := WithRetry(context.Background(), provider, types.LlmStreamOptions{Model: "test-model"}, cfg)
	for range events {
	}
	err := <-errc
	pe, ok := err.(*ProviderError)
	if !ok || pe.Reason != ReasonPrincipalCredentialUnresolved {
		t.Fatalf("expected the refusal to pass through unchanged, got %+v", err)
	}
	if provider.callCount != 1 {
		t.Fatalf("expected exactly 1 attempt (no self-heal for a principal refusal), got %d", provider.callCount)
	}
}

// TestAuthRejectionNoAttachAuthNoSelfHeal pins that the self-heal only
// engages when the caller wired AttachAuth -- a caller with no per-principal
// credential wiring (AttachAuth nil) gets the pre-existing behavior: an
// immediate non-retryable failure, since there is nothing to re-resolve.
func TestAuthRejectionNoAttachAuthNoSelfHeal(t *testing.T) {
	authErr := &ProviderError{Code: ErrAuth, Message: "unauthorized", HTTPStatus: 401, Retryable: false}
	provider := &midStreamFailProvider{
		id:        "test-prov",
		failCount: 1000,
		failErr:   authErr,
	}

	events, errc := WithRetry(context.Background(), provider, types.LlmStreamOptions{Model: "test-model"}, &RetryConfig{})
	for range events {
	}
	err := <-errc
	if err == nil {
		t.Fatal("expected the auth error to pass through")
	}
	if provider.callCount != 1 {
		t.Fatalf("expected exactly 1 attempt with no AttachAuth wired, got %d", provider.callCount)
	}
}
