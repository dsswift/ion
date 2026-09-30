package appconfig

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

type staticTokenProvider struct{ scope, audience string }

func (p *staticTokenProvider) GetToken(ctx context.Context, scope string) (string, error) {
	return p.GetTokenWithAudience(ctx, scope, "")
}

func (p *staticTokenProvider) GetTokenWithAudience(_ context.Context, scope, audience string) (string, error) {
	p.scope, p.audience = scope, audience
	return "minted-token", nil
}

func TestHTTPFetcher(t *testing.T) {
	provider := &staticTokenProvider{}
	auth.SetTokenProvider(provider)
	t.Cleanup(func() { auth.SetTokenProvider(nil) })

	var authorization string
	body, status := `{"region":"east","features":["a"]}`, http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body)) //nolint:errcheck // test server write
	}))
	defer server.Close()
	source := types.ApplicationConfigSource{Endpoint: server.URL, Scope: "api://config/.default", Audience: "config"}

	values, err := HTTPFetcher(context.Background(), source)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if values["region"] != "east" || authorization != "Bearer minted-token" {
		t.Fatalf("values=%v authorization=%q", values, authorization)
	}
	if provider.scope != source.Scope || provider.audience != source.Audience {
		t.Fatalf("token minted for scope=%q audience=%q", provider.scope, provider.audience)
	}

	for _, tc := range []struct {
		name, body string
		status     int
		wantErr    string
	}{
		{"non-2xx", `{}`, http.StatusForbidden, "status 403"},
		{"array", `[1,2]`, http.StatusOK, "not a JSON object"},
		{"null", `null`, http.StatusOK, "not a JSON object"},
	} {
		body, status = tc.body, tc.status
		if _, err := HTTPFetcher(context.Background(), source); err == nil || !strings.Contains(err.Error(), tc.wantErr) {
			t.Fatalf("%s: err=%v, want %q", tc.name, err, tc.wantErr)
		}
	}
}

func TestHTTPFetcherWithoutTokenProviderFails(t *testing.T) {
	auth.SetTokenProvider(nil)
	_, err := HTTPFetcher(context.Background(), types.ApplicationConfigSource{Endpoint: "https://config.example.invalid"})
	if err == nil || !strings.Contains(err.Error(), "authenticate request") {
		t.Fatalf("a fetch with no identity token provider must fail before any request: %v", err)
	}
}
