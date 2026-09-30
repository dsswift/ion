package subscription

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

type stubTokens struct{}

func (stubTokens) GetToken(ctx context.Context, scope string) (string, error) {
	return stubTokens{}.GetTokenWithAudience(ctx, scope, "")
}

func (stubTokens) GetTokenWithAudience(_ context.Context, scope, audience string) (string, error) {
	return "token:" + scope + ":" + audience, nil
}

func TestHTTPFetcherSendsIdentityTokenAndVersion(t *testing.T) {
	auth.SetTokenProvider(stubTokens{})
	t.Cleanup(func() { auth.SetTokenProvider(nil) })
	var gotAuth, gotVersion string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotVersion = r.Header.Get(VersionHeader)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"id":"std","label":"Standard","key":"key-std","tier":"basic"}]`)) //nolint:errcheck // test server write
	}))
	t.Cleanup(server.Close)

	subs, err := HTTPFetcher(context.Background(), types.SubscriptionLookupConfig{Endpoint: server.URL, Provider: "gateway", Scope: "api://keys/.default", Audience: "keys"})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if gotAuth != "Bearer token:api://keys/.default:keys" || gotVersion != ContractVersion {
		t.Fatalf("authorization %q, version %q", gotAuth, gotVersion)
	}
	if len(subs) != 1 || subs[0] != (Subscription{ID: "std", Label: "Standard", Key: "key-std"}) {
		t.Fatalf("subscriptions = %+v", subs)
	}
}

func TestHTTPFetcherFailsOnStatusAndMissingIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	t.Cleanup(server.Close)
	cfg := types.SubscriptionLookupConfig{Endpoint: server.URL, Provider: "gateway"}

	auth.SetTokenProvider(nil)
	if _, err := HTTPFetcher(context.Background(), cfg); err == nil || !strings.Contains(err.Error(), "authenticate") {
		t.Fatalf("fetch without an identity = %v", err)
	}
	auth.SetTokenProvider(stubTokens{})
	t.Cleanup(func() { auth.SetTokenProvider(nil) })
	if _, err := HTTPFetcher(context.Background(), cfg); err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("fetch on 403 = %v", err)
	}
}

func TestDecodeResponse(t *testing.T) {
	empty, err := DecodeResponse([]byte(`[]`))
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty array = %v, %v", empty, err)
	}
	for name, body := range map[string]string{
		"object":       `{"subscriptions":[]}`,
		"null":         `null`,
		"no id":        `[{"label":"A","key":"k"}]`,
		"no label":     `[{"id":"a","key":"k"}]`,
		"no key":       `[{"id":"a","label":"A"}]`,
		"duplicate id": `[{"id":"a","label":"A","key":"k"},{"id":"a","label":"B","key":"j"}]`,
	} {
		if _, err := DecodeResponse([]byte(body)); err == nil {
			t.Errorf("%s: accepted %s", name, body)
		}
	}
}

func TestFileStoreCacheRoundTripPerIdentity(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	cache := NewFileStoreCache()
	if entry, err := cache.Load("user-1", "gateway"); err != nil || entry != nil {
		t.Fatalf("empty store load = %+v, %v", entry, err)
	}
	want := CacheEntry{SelectedID: "std", Label: "Standard", Key: "key-std", Options: []types.SubscriptionOption{{ID: "std", Label: "Standard"}}, ResolvedAt: 42}
	if err := cache.Save("user-1", "gateway", want); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := cache.Load("user-1", "gateway")
	if err != nil || got == nil || got.Key != "key-std" || got.ResolvedAt != 42 || len(got.Options) != 1 {
		t.Fatalf("load = %+v, %v", got, err)
	}
	if other, err := cache.Load("user-2", "gateway"); err != nil || other != nil {
		t.Fatalf("another identity read the entry: %+v, %v", other, err)
	}
	resolver := auth.NewResolver(nil)
	for _, stored := range resolver.ListStoredFor("user-1") {
		if strings.HasPrefix(stored.Provider, auth.SubscriptionCachePrefix) {
			t.Fatalf("cache entry listed as a stored credential: %+v", stored)
		}
	}
	if err := cache.Delete("user-1", "gateway"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if entry, err := cache.Load("user-1", "gateway"); err != nil || entry != nil {
		t.Fatalf("load after delete = %+v, %v", entry, err)
	}
}
