package server

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// refreshModelsResult dispatches refresh_models for one provider whose models
// endpoint is baseURL and returns the ServerResult written to the client.
func refreshModelsResult(t *testing.T, provider, baseURL string) protocol.ServerResult {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	providers.ResetDiscoveryCache()
	t.Cleanup(providers.ResetDiscoveryCache)

	r := auth.NewResolver(nil)
	r.SetProgrammatic(provider, "test-key")
	s := &Server{
		authResolver: r,
		config:       &types.EngineRuntimeConfig{Providers: map[string]types.ProviderConfig{provider: {BaseURL: baseURL}}},
	}

	client, server := net.Pipe()
	t.Cleanup(func() {
		client.Close() //nolint:errcheck // test pipe teardown
		server.Close() //nolint:errcheck // test pipe teardown
	})
	resultCh := make(chan protocol.ServerResult, 1)
	go func() { resultCh <- readListModelsResult(t, client) }()

	s.dispatch(server, &protocol.ClientCommand{Cmd: "refresh_models", Provider: provider, RequestID: "req-1"})
	return <-resultCh
}

// refreshResultEntries decodes the per-provider outcomes from result data.
func refreshResultEntries(t *testing.T, res protocol.ServerResult) []map[string]any {
	t.Helper()
	data, ok := res.Data.(map[string]any)
	if !ok {
		t.Fatalf("expected map result data, got %T", res.Data)
	}
	raw, ok := data["results"].([]any)
	if !ok {
		t.Fatalf("expected a results array, got %v", data["results"])
	}
	entries := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		entry, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("expected an object entry, got %T", item)
		}
		entries = append(entries, entry)
	}
	return entries
}

// TestRefreshModels_DiscoveryFailureIsNotOK pins that a refresh whose only
// targeted provider fails discovery answers ok=false with the reason, on the
// wire, and still carries the per-provider outcome.
func TestRefreshModels_DiscoveryFailureIsNotOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "upstream down", http.StatusInternalServerError)
	}))
	defer srv.Close()

	res := refreshModelsResult(t, "refresh-gw-down", srv.URL)

	if res.OK {
		t.Fatal("expected ok=false when discovery fails for the only targeted provider")
	}
	if !strings.Contains(res.Error, "discovery failed for 1 of 1 provider(s)") {
		t.Errorf("unexpected error text: %q", res.Error)
	}
	entries := refreshResultEntries(t, res)
	if len(entries) != 1 {
		t.Fatalf("expected one provider outcome, got %v", entries)
	}
	if entries[0]["provider"] != "refresh-gw-down" || entries[0]["status"] != "failed" {
		t.Errorf("expected refresh-gw-down failed, got %v", entries[0])
	}
	if reason, _ := entries[0]["reason"].(string); !strings.Contains(reason, "status 500") { //nolint:errcheck // a non-string reason fails the assertion below
		t.Errorf("expected the http status in the reason, got %v", entries[0]["reason"])
	}
}

// TestRefreshModels_DiscoverySuccessIsOK pins the success shape: ok=true, no
// error, and the outcome with its model count.
func TestRefreshModels_DiscoverySuccessIsOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[{"id":"refresh-model-a"},{"id":"refresh-model-b"}]}`)
	}))
	defer srv.Close()

	res := refreshModelsResult(t, "refresh-gw-up", srv.URL)

	if !res.OK || res.Error != "" {
		t.Fatalf("expected an ok result, got ok=%v error=%q", res.OK, res.Error)
	}
	entries := refreshResultEntries(t, res)
	if len(entries) != 1 {
		t.Fatalf("expected one provider outcome, got %v", entries)
	}
	if entries[0]["status"] != "ok" || entries[0]["modelCount"] != float64(2) {
		t.Errorf("expected ok with 2 models, got %v", entries[0])
	}
	if _, present := entries[0]["reason"]; present {
		t.Errorf("expected no reason on an ok outcome, got %v", entries[0])
	}
}
