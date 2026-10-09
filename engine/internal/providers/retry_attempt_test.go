package providers

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

type attemptRecord struct {
	attempt  int
	model    string
	provider string
	outcome  string
	ttftMs   float64
	err      error
}

// Every request to the provider is reported once through OnAttemptStart:
// a failed first attempt ends "retry" with no first event, the successful
// second ends "ok" with a positive time to first event.
func TestWithRetryObservesEveryAttempt(t *testing.T) {
	provider := &midStreamFailProvider{
		id:        "attempt-prov",
		failCount: 1,
		failErr:   NewProviderError(ErrStreamTruncated, "stream died", 0, true),
		successEvents: []types.LlmStreamEvent{
			{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m_ok", Model: "attempt"}},
			{Type: "message_stop"},
		},
	}
	var records []attemptRecord
	config := &RetryConfig{MaxRetries: 3, BaseDelayMs: 1, MaxDelayMs: 1,
		OnAttemptStart: func(attempt int, model, providerID string) func(string, float64, error) {
			i := len(records)
			records = append(records, attemptRecord{attempt: attempt, model: model, provider: providerID})
			return func(outcome string, ttftMs float64, err error) {
				records[i].outcome, records[i].ttftMs, records[i].err = outcome, ttftMs, err
			}
		},
	}
	events, errc := WithRetry(context.Background(), provider, types.LlmStreamOptions{Model: "attempt-model"}, config)
	for range events {
	}
	if err := <-errc; err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("attempts observed = %d, want 2: %+v", len(records), records)
	}
	first, second := records[0], records[1]
	if first.attempt != 0 || first.outcome != AttemptOutcomeRetry || first.err == nil || first.ttftMs != 0 {
		t.Fatalf("first attempt = %+v, want attempt 0 ending retry with its error and no first event", first)
	}
	if second.attempt != 1 || second.outcome != AttemptOutcomeOK || second.err != nil || second.ttftMs <= 0 {
		t.Fatalf("second attempt = %+v, want attempt 1 ending ok with a positive ttft", second)
	}
	if first.model != "attempt-model" || first.provider != "attempt-prov" {
		t.Fatalf("attempt identity = %+v", first)
	}
}

// A non-retryable error ends the attempt "error" and is reported once.
func TestWithRetryObservesTerminalError(t *testing.T) {
	provider := &midStreamFailProvider{
		id:        "fatal-prov",
		failCount: 1,
		failErr:   NewProviderError(ErrInvalidReq, "bad request", 0, false),
	}
	var outcomes []string
	config := &RetryConfig{MaxRetries: 3, BaseDelayMs: 1, MaxDelayMs: 1,
		OnAttemptStart: func(int, string, string) func(string, float64, error) {
			return func(outcome string, _ float64, _ error) { outcomes = append(outcomes, outcome) }
		},
	}
	events, errc := WithRetry(context.Background(), provider, types.LlmStreamOptions{Model: "m"}, config)
	for range events {
	}
	if err := <-errc; err == nil {
		t.Fatal("expected the terminal error")
	}
	if len(outcomes) != 1 || outcomes[0] != AttemptOutcomeError {
		t.Fatalf("outcomes = %v, want [error]", outcomes)
	}
}
