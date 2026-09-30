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

	var authorization, ifNoneMatch, ifModifiedSince string
	body, status := `{"common":{"values":{"region":"east","features":["a"]}}}`, http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		ifNoneMatch, ifModifiedSince = r.Header.Get("If-None-Match"), r.Header.Get("If-Modified-Since")
		w.Header().Set("ETag", `"v1"`)
		w.Header().Set("Last-Modified", "Tue, 29 Sep 2026 10:00:00 GMT")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body)) //nolint:errcheck // test server write
	}))
	defer server.Close()
	source := types.ApplicationConfigSource{Endpoint: server.URL, Scope: "api://config/.default", Audience: "config"}

	result, err := HTTPFetcher(context.Background(), source, Validators{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if result.Document.Common.Values["region"] != "east" || authorization != "Bearer minted-token" {
		t.Fatalf("document=%+v authorization=%q", result.Document, authorization)
	}
	if ifNoneMatch != "" || ifModifiedSince != "" {
		t.Fatalf("a first fetch must be unconditional: %q %q", ifNoneMatch, ifModifiedSince)
	}
	want := Validators{ETag: `"v1"`, LastModified: "Tue, 29 Sep 2026 10:00:00 GMT"}
	if result.Validators != want {
		t.Fatalf("validators = %+v, want %+v", result.Validators, want)
	}

	// A refresh sends the validators back; 304 confirms the document.
	body, status = "", http.StatusNotModified
	unchanged, err := HTTPFetcher(context.Background(), source, want)
	if err != nil || !unchanged.NotModified || unchanged.Document != nil || unchanged.Validators != want {
		t.Fatalf("not modified: %+v %v", unchanged, err)
	}
	if ifNoneMatch != want.ETag || ifModifiedSince != want.LastModified {
		t.Fatalf("a refresh must send the validators: %q %q", ifNoneMatch, ifModifiedSince)
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
		{"unconditional 304", ``, http.StatusNotModified, "status 304"},
		{"flat object", `{"region":"east"}`, http.StatusOK, "unknown field"},
		{"null", `null`, http.StatusOK, "got null"},
	} {
		body, status = tc.body, tc.status
		if _, err := HTTPFetcher(context.Background(), source, Validators{}); err == nil || !strings.Contains(err.Error(), tc.wantErr) {
			t.Fatalf("%s: err=%v, want %q", tc.name, err, tc.wantErr)
		}
	}
}

func TestHTTPFetcherWithoutTokenProviderFails(t *testing.T) {
	auth.SetTokenProvider(nil)
	_, err := HTTPFetcher(context.Background(), types.ApplicationConfigSource{Endpoint: "https://config.example.invalid"}, Validators{})
	if err == nil || !strings.Contains(err.Error(), "authenticate request") {
		t.Fatalf("a fetch with no identity token provider must fail before any request: %v", err)
	}
}
