package mcp

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dsswift/ion/engine/internal/secretref"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestMCPSecretHeadersResolvePerRequest pins that a secret header is
// resolved on every request, so a rotated value is sent next time, and that
// an unresolvable secret fails the request instead of sending it bare.
func TestMCPSecretHeadersResolvePerRequest(t *testing.T) {
	current := "key-v1"
	var readers []secretref.Reader
	prev := resolveMCPSecret
	resolveMCPSecret = func(reader secretref.Reader, ref types.SecretReference) (string, error) {
		readers = append(readers, reader)
		if ref.SecretRef != "gatewayKey" || ref.SecretSource != types.SecretSourceApplicationConfig {
			return "", errors.New("unexpected reference")
		}
		if current == "" {
			return "", errors.New("application config is deferred")
		}
		return current, nil
	}
	t.Cleanup(func() { resolveMCPSecret = prev })

	seen := make(chan string, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("Ocp-Apim-Subscription-Key")
	}))
	t.Cleanup(srv.Close)
	client := ionMCPHTTPClient("erm", types.McpServerConfig{Type: "http", URL: srv.URL, SecretHeaders: map[string]types.McpSecretHeader{
		"Ocp-Apim-Subscription-Key": {SecretReference: types.SecretReference{SecretRef: "gatewayKey", SecretSource: types.SecretSourceApplicationConfig}},
	}})

	for _, want := range []string{"key-v1", "key-v2"} {
		current = want
		resp, err := client.Get(srv.URL)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if err := resp.Body.Close(); err != nil {
			t.Fatalf("close: %v", err)
		}
		if got := <-seen; got != want {
			t.Fatalf("header = %q, want %q", got, want)
		}
	}
	if readers[0] != (secretref.Reader{}) {
		t.Fatalf("an MCP connection reads as no principal and no extension: %+v", readers[0])
	}

	current = ""
	if _, err := client.Get(srv.URL); err == nil {
		t.Fatal("an unresolvable secret must fail the request")
	}
	select {
	case got := <-seen:
		t.Fatalf("a request went out without its secret (header %q)", got)
	default:
	}
}
