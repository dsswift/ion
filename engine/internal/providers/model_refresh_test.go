package providers

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// modelsServer serves a one-model /v1/models list.
func modelsServer(t *testing.T, modelID string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":[{"id":%q}]}`, modelID)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// failingServer answers every request with a 500.
func failingServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "upstream down", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// isolateRegistries empties the provider registry and discovery cache for one
// test, registers the given provider ids, and restores the built-ins after.
func isolateRegistries(t *testing.T, ids ...string) {
	t.Helper()
	ResetRegistries()
	ResetDiscoveryCache()
	SetCliBackedProviders(map[string]bool{})
	t.Cleanup(func() {
		ResetRegistries()
		restoreInitRegistries()
		ResetDiscoveryCache()
		SetCliBackedProviders(map[string]bool{})
	})
	for _, id := range ids {
		RegisterProvider(&mockProvider{id: id})
	}
}

func staticKey(string) (string, error) { return "key", nil }

func resultFor(t *testing.T, results []ModelRefreshResult, provider string) ModelRefreshResult {
	t.Helper()
	for _, r := range results {
		if r.Provider == provider {
			return r
		}
	}
	t.Fatalf("no result for provider %q in %+v", provider, results)
	return ModelRefreshResult{}
}

func TestRefreshModels_NamedProviderFetchFailureIsReported(t *testing.T) {
	isolateRegistries(t)
	srv := failingServer(t)
	configs := map[string]types.ProviderConfig{"gw-down": {BaseURL: srv.URL}}

	results := RefreshModels("gw-down", true, staticKey, configs)

	if len(results) != 1 {
		t.Fatalf("expected one result, got %+v", results)
	}
	got := results[0]
	if got.Provider != "gw-down" || got.Status != ModelRefreshFailed {
		t.Fatalf("expected gw-down failed, got %+v", got)
	}
	if !strings.Contains(got.Reason, "status 500") {
		t.Errorf("expected the http status in the reason, got %q", got.Reason)
	}
	err := ModelRefreshError(results)
	if err == nil {
		t.Fatal("expected an error when the only targeted provider failed")
	}
	if !strings.Contains(err.Error(), "discovery failed for 1 of 1 provider(s)") || !strings.Contains(err.Error(), "gw-down") {
		t.Errorf("unexpected error text: %v", err)
	}
}

func TestRefreshModels_NamedProviderSuccess(t *testing.T) {
	isolateRegistries(t)
	srv := modelsServer(t, "model-a")
	configs := map[string]types.ProviderConfig{"gw-up": {BaseURL: srv.URL}}

	results := RefreshModels("gw-up", true, staticKey, configs)

	want := ModelRefreshResult{Provider: "gw-up", Status: ModelRefreshOK, ModelCount: 1}
	if len(results) != 1 || results[0] != want {
		t.Fatalf("expected %+v, got %+v", want, results)
	}
	if err := ModelRefreshError(results); err != nil {
		t.Errorf("expected no error, got %v", err)
	}
}

func TestRefreshModels_NamedProviderWithoutCredentialFails(t *testing.T) {
	isolateRegistries(t)
	configs := map[string]types.ProviderConfig{"gw-nokey": {BaseURL: "http://example.invalid"}}
	noKey := func(string) (string, error) { return "", fmt.Errorf("not found") }

	results := RefreshModels("gw-nokey", true, noKey, configs)

	if len(results) != 1 || results[0].Status != ModelRefreshFailed || !strings.Contains(results[0].Reason, "no credential") {
		t.Fatalf("expected a no-credential failure, got %+v", results)
	}
}

func TestRefreshModels_NamedProviderWithoutBaseURLFails(t *testing.T) {
	isolateRegistries(t)

	results := RefreshModels("gw-nourl", true, staticKey, nil)

	if len(results) != 1 || results[0].Status != ModelRefreshFailed || results[0].Reason != "no base url configured" {
		t.Fatalf("expected a no-base-url failure, got %+v", results)
	}
}

func TestRefreshModels_AllProvidersPartialFailure(t *testing.T) {
	isolateRegistries(t, "gw-up", "gw-down", "gw-nokey")
	configs := map[string]types.ProviderConfig{
		"gw-up":    {BaseURL: modelsServer(t, "model-a").URL},
		"gw-down":  {BaseURL: failingServer(t).URL},
		"gw-nokey": {BaseURL: "http://example.invalid"},
	}
	resolveKey := func(provider string) (string, error) {
		if provider == "gw-nokey" {
			return "", fmt.Errorf("not found")
		}
		return "key", nil
	}

	results := RefreshModels("", true, resolveKey, configs)

	if len(results) != 3 {
		t.Fatalf("expected one result per provider, got %+v", results)
	}
	if got := resultFor(t, results, "gw-up"); got.Status != ModelRefreshOK || got.ModelCount != 1 {
		t.Errorf("expected gw-up ok with 1 model, got %+v", got)
	}
	if got := resultFor(t, results, "gw-down"); got.Status != ModelRefreshFailed || got.Reason == "" {
		t.Errorf("expected gw-down failed with a reason, got %+v", got)
	}
	if got := resultFor(t, results, "gw-nokey"); got.Status != ModelRefreshSkipped {
		t.Errorf("expected a provider with no credential to be skipped, got %+v", got)
	}
	if err := ModelRefreshError(results); err != nil {
		t.Errorf("a partial failure must not be an error, got %v", err)
	}
}

func TestRefreshModels_AllProvidersTotalFailure(t *testing.T) {
	isolateRegistries(t, "gw-down-a", "gw-down-b")
	configs := map[string]types.ProviderConfig{
		"gw-down-a": {BaseURL: failingServer(t).URL},
		"gw-down-b": {BaseURL: failingServer(t).URL},
	}

	results := RefreshModels("", true, staticKey, configs)

	err := ModelRefreshError(results)
	if err == nil {
		t.Fatalf("expected an error when every targeted provider failed, got results %+v", results)
	}
	if !strings.Contains(err.Error(), "discovery failed for 2 of 2 provider(s)") {
		t.Errorf("unexpected error text: %v", err)
	}
}

// A keyless provider the operator never configured is probed at its default
// endpoint. When nothing answers there, a refresh of every provider must not
// count it as a failure.
func TestRefreshModels_AllProvidersUnconfiguredKeylessProbeIsSkipped(t *testing.T) {
	isolateRegistries(t, "ollama")
	closed := failingServer(t)
	closed.Close()
	original := defaultBaseURLs["ollama"]
	defaultBaseURLs["ollama"] = closed.URL
	t.Cleanup(func() { defaultBaseURLs["ollama"] = original })
	noKey := func(string) (string, error) { return "", nil }

	results := RefreshModels("", true, noKey, nil)

	if got := resultFor(t, results, "ollama"); got.Status != ModelRefreshSkipped || got.Reason == "" {
		t.Fatalf("expected the unanswered probe to be skipped with a reason, got %+v", got)
	}
	if err := ModelRefreshError(results); err != nil {
		t.Errorf("expected no error, got %v", err)
	}

	named := RefreshModels("ollama", true, noKey, nil)
	if len(named) != 1 || named[0].Status != ModelRefreshFailed {
		t.Errorf("expected a named refresh of the same provider to fail, got %+v", named)
	}
}

func TestModelRefreshError_NothingTargetedIsNotAnError(t *testing.T) {
	results := []ModelRefreshResult{{Provider: "a", Status: ModelRefreshSkipped, Reason: "no credential"}}
	if err := ModelRefreshError(results); err != nil {
		t.Errorf("expected no error, got %v", err)
	}
	if err := ModelRefreshError(nil); err != nil {
		t.Errorf("expected no error for an empty refresh, got %v", err)
	}
}
