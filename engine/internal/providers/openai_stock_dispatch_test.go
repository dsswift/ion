package providers

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestStockOpenAIProviderDispatchesByDialect pins that the first-class openai
// provider sends a catalog model declared "openai-responses" to /v1/responses
// and leaves an undeclared model on /v1/chat/completions.
func TestStockOpenAIProviderDispatchesByDialect(t *testing.T) {
	paths := make(chan string, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths <- r.URL.Path
		w.Header().Set("Content-Type", "text/event-stream")
		if r.URL.Path == "/v1/responses" {
			fmt.Fprint(w, "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n")
			return
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer srv.Close()

	ApplyConfig(map[string]types.ProviderConfig{"openai": {BaseURL: srv.URL}})
	t.Cleanup(func() { RegisterProvider(newStockOpenAIProvider("", "")) })

	p := GetProvider("openai")
	if p == nil {
		t.Fatal("openai provider not registered")
	}
	authCtx := WithRequestCredential(t.Context(), testStaticAuthenticator{key: "k", header: "bearer"})
	for model, wantPath := range map[string]string{
		"gpt-6.1-sol": "/v1/responses",
		"gpt-4.1":     "/v1/chat/completions",
	} {
		events, errc := p.Stream(authCtx, types.LlmStreamOptions{
			Model:    model,
			Messages: []types.LlmMessage{{Role: "user", Content: "hi"}},
		})
		for range events { //nolint:revive // drain
		}
		<-errc // the mock stream is minimal; the path is the assertion
		if gotPath := <-paths; gotPath != wantPath {
			t.Errorf("model %q hit %q, want %q", model, gotPath, wantPath)
		}
	}
}
