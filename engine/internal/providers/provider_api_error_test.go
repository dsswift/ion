package providers

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// A gateway registered under its own id speaks another company's wire format.
// The refusal must name the gateway, because that is who refused.
func TestProviderAPIErrorNamesTheConfiguredProvider(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"type":"rate_limit_error","message":"quota exceeded"}}`)) //nolint:errcheck // test server write
	}))
	defer server.Close()

	cases := map[string]LlmProvider{
		"anthropic wire":        NewAnthropicProvider(&ProviderOptions{ID: "acme-gateway", APIKey: "k", BaseURL: server.URL}),
		"openai wire":           NewOpenAIProvider(&ProviderOptions{ID: "acme-gateway", APIKey: "k", BaseURL: server.URL}),
		"openai responses wire": NewOpenAIResponsesProvider(&ProviderOptions{ID: "acme-gateway", APIKey: "k", BaseURL: server.URL}),
	}
	for name, provider := range cases {
		t.Run(name, func(t *testing.T) {
			events, errc := provider.Stream(t.Context(), types.LlmStreamOptions{
				Model:    "test-model",
				Messages: []types.LlmMessage{{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "hi"}}}},
			})
			for range events { //nolint:revive // drain
			}
			err := <-errc
			if err == nil {
				t.Fatal("expected an error for a 429 response")
			}
			var pe *ProviderError
			if !errors.As(err, &pe) {
				t.Fatalf("expected a ProviderError, got %T", err)
			}
			if pe.Code != ErrRateLimit {
				t.Errorf("code = %q, want %q", pe.Code, ErrRateLimit)
			}
			if !strings.Contains(pe.Error(), `"acme-gateway"`) {
				t.Errorf("message does not name the refusing provider: %s", pe.Error())
			}
			if !strings.Contains(pe.Error(), "HTTP 429") {
				t.Errorf("message does not carry the status: %s", pe.Error())
			}
		})
	}
}
