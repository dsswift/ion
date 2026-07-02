package providers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestCountTokens_OpenAIReturnsUnsupported(t *testing.T) {
	p := NewOpenAIProvider(&ProviderOptions{APIKey: "test"})
	_, err := p.CountTokens(context.Background(), CountTokensRequest{
		Model:    "gpt-4o",
		Messages: []types.LlmMessage{{Role: "user", Content: "hi"}},
	})
	if !errors.Is(err, ErrCountUnsupported) {
		t.Fatalf("expected ErrCountUnsupported, got %v", err)
	}
}

func TestCountTokens_AnthropicMarshal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages/count_tokens" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"input_tokens":42}`))
	}))
	defer srv.Close()

	p := NewAnthropicProvider(&ProviderOptions{APIKey: "test", BaseURL: srv.URL})
	count, err := p.CountTokens(context.Background(), CountTokensRequest{
		Model:    "claude-sonnet-4-6",
		System:   "you are a bot",
		Messages: []types.LlmMessage{{Role: "user", Content: "hello"}},
		Tools: []types.LlmToolDef{{
			Name:        "Read",
			Description: "read a file",
			InputSchema: map[string]any{"type": "object"},
		}},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 42 {
		t.Fatalf("expected count 42, got %d", count)
	}
}

func TestCountTokens_AnthropicServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv.Close()

	p := NewAnthropicProvider(&ProviderOptions{APIKey: "test", BaseURL: srv.URL})
	_, err := p.CountTokens(context.Background(), CountTokensRequest{
		Model:    "claude-sonnet-4-6",
		Messages: []types.LlmMessage{{Role: "user", Content: "hello"}},
	})
	if err == nil {
		t.Fatalf("expected error on 500 response, got nil")
	}
}
