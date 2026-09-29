package providers

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestDeriveModelDisplayName(t *testing.T) {
	cases := []struct{ id, want string }{
		{"claude-opus-4-8", "Claude Opus 4.8"},
		{"claude-haiku-4-5", "Claude Haiku 4.5"},
		{"claude-haiku-4-5-20251001", "Claude Haiku 4.5"},
		{"claude-fable-5", "Claude Fable 5"},
		// A release date is never read as a minor version.
		{"claude-opus-4-20250514", "Claude Opus 4"},
		{"claude-3-5-sonnet-20241022", "Claude Sonnet 3.5"},
		{"claude-3-opus-20240229", "Claude Opus 3"},
		// Claude ids inside longer gateway and Bedrock ids.
		{"anthropic.claude-sonnet-4-5-20250929-v1:0", "Claude Sonnet 4.5"},
		{"my-gateway-claude-sonnet-4-6", "Claude Sonnet 4.6"},
		{"gpt-5.2-codex", "GPT-5.2 Codex"},
		{"gpt-4.1-mini", "GPT-4.1 Mini"},
		{"gpt-4o", "GPT-4o"},
		{"gpt-5", "GPT-5"},
		{"gemini-2.5-flash", "Gemini 2.5 Flash"},
		{"grok-3-mini-fast", "Grok 3 Mini Fast"},
		// Unknown shapes stay unnamed rather than guessed at.
		{"FLUX.2-pro", ""},
		{"gpt-image-1", ""},
		{"o4-mini", ""},
		{"llama-3.3-70b", ""},
		{"claude", ""},
	}
	for _, c := range cases {
		if got := DeriveModelDisplayName(c.id); got != c.want {
			t.Errorf("DeriveModelDisplayName(%q) = %q, want %q", c.id, got, c.want)
		}
	}
}

// TestDiscoveryReadsAnthropicDisplayName pins that a gateway's /v1/models is
// named from the Anthropic `display_name` field, the one Claude Code reads, and
// that it wins over Ion's camelCase `displayName` when both are present.
func TestDiscoveryReadsAnthropicDisplayName(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[
			{"id":"claude-opus-4-8","display_name":"Opus via Gateway"},
			{"id":"gpt-5.2-codex","displayName":"Codex (camel)"},
			{"id":"claude-sonnet-5","display_name":"Sonnet Snake","displayName":"Sonnet Camel"},
			{"id":"FLUX.2-pro"}
		]}`)
	}))
	defer srv.Close()

	models, err := fetchModelsForProvider("name-gw", srv.URL, "key", "")
	if err != nil {
		t.Fatalf("fetch error: %v", err)
	}
	byID := make(map[string]types.ModelEntry)
	for _, m := range models {
		byID[m.ID] = m
	}
	want := map[string]string{
		"claude-opus-4-8": "Opus via Gateway",
		"gpt-5.2-codex":   "Codex (camel)",
		"claude-sonnet-5": "Sonnet Snake",
		"FLUX.2-pro":      "",
	}
	for id, name := range want {
		if got := byID[id].DisplayName; got != name {
			t.Errorf("%s DisplayName = %q, want %q", id, got, name)
		}
	}
}

// TestListModels_DerivesNameForUnnamedModel pins the last naming fallback: a
// model no payload or catalog named is named from its id, a published name is
// never replaced, and an id with no known shape stays unnamed.
func TestListModels_DerivesNameForUnnamedModel(t *testing.T) {
	ResetDiscoveryCache()
	t.Cleanup(ResetDiscoveryCache)

	const gateway = "derive-gw"
	setDiscoveredOnly(gateway, []types.ModelEntry{
		{ID: "gpt-5.2-codex", ProviderID: gateway},
		{ID: "claude-haiku-4-5", ProviderID: gateway},
		{ID: "gpt-5.3-codex", ProviderID: gateway, DisplayName: "Published Name"},
		{ID: "FLUX.2-pro", ProviderID: gateway},
	})

	byID := make(map[string]types.ModelEntry)
	for _, m := range ListModels() {
		if m.ProviderID == gateway {
			byID[m.ID] = m
		}
	}
	want := map[string]string{
		"gpt-5.2-codex":    "GPT-5.2 Codex",
		"claude-haiku-4-5": "Claude Haiku 4.5",
		"gpt-5.3-codex":    "Published Name",
		"FLUX.2-pro":       "",
	}
	for id, name := range want {
		if got := byID[id].DisplayName; got != name {
			t.Errorf("%s DisplayName = %q, want %q", id, got, name)
		}
	}
}
