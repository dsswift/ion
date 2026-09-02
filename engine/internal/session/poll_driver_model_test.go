package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// writeTierConfig writes a models.json into the test HOME so modelconfig tier
// lookups resolve. The session package redirects HOME to a temp dir in TestMain,
// so this never touches the operator's real ~/.ion/models.json.
func writeTierConfig(t *testing.T, tiers map[string]string) {
	t.Helper()
	dir := filepath.Join(os.Getenv("HOME"), ".ion")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("create test .ion dir: %v", err)
	}
	path := filepath.Join(dir, "models.json")
	body, err := json.Marshal(map[string]any{"tiers": tiers})
	if err != nil {
		t.Fatalf("marshal tier config: %v", err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write tier config: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Errorf("remove tier config: %v", err)
		}
	})
}

// A poll child is mechanical evidence judging, so it must take the fast tier
// rather than the conversation's model. This is the first rung of the chain.
func TestResolvePollModelPrefersFastTier(t *testing.T) {
	writeTierConfig(t, map[string]string{"fast": "fast-model", "standard": "standard-model"})
	m := &Manager{config: &types.EngineRuntimeConfig{DefaultModel: "default-model"}}

	if got := m.resolvePollModel(); got != "fast-model" {
		t.Fatalf("resolvePollModel() = %q, want %q", got, "fast-model")
	}
}

// With no fast tier the chain falls to standard, NOT to the parent model. A
// premium-model conversation must never buy premium-model polling.
func TestResolvePollModelFallsBackToStandardTier(t *testing.T) {
	writeTierConfig(t, map[string]string{"standard": "standard-model", "chiefs": "expensive-model"})
	m := &Manager{config: &types.EngineRuntimeConfig{DefaultModel: "default-model"}}

	if got := m.resolvePollModel(); got != "standard-model" {
		t.Fatalf("resolvePollModel() = %q, want %q", got, "standard-model")
	}
}

// With neither tier configured the last resort is the engine default, because
// that is operator configuration. The parent model is not in the chain at all.
func TestResolvePollModelFallsBackToEngineDefault(t *testing.T) {
	writeTierConfig(t, map[string]string{"chiefs": "expensive-model"})
	m := &Manager{config: &types.EngineRuntimeConfig{DefaultModel: "default-model"}}

	if got := m.resolvePollModel(); got != "default-model" {
		t.Fatalf("resolvePollModel() = %q, want %q", got, "default-model")
	}
}

// The regression this pins: startPoll used to fall back to the parent model, so
// a poll on a premium conversation ran the premium model on every attempt. The
// model the driver selects must now come from the tier chain instead.
//
// This asserts the selection expression startPoll uses, in the same precedence
// order, rather than calling startPoll itself — startPoll's first act is to
// dispatch a live child run, which a unit test must not do. Reverting the
// driver's fallback from resolvePollModel() to parentModel turns this red.
func TestPollModelSelectionIgnoresConversationModel(t *testing.T) {
	writeTierConfig(t, map[string]string{"fast": "fast-model", "chiefs": "expensive-model"})
	m := &Manager{config: &types.EngineRuntimeConfig{DefaultModel: "default-model"}}
	const conversationModel = "expensive-model"

	got := selectPollModel(m, m.pollConfig(), tools.PollRequest{})

	if got == conversationModel {
		t.Fatalf("poll child inherited the conversation model %q", conversationModel)
	}
	if got != "fast-model" {
		t.Fatalf("poll child model = %q, want the fast tier %q", got, "fast-model")
	}
}

// An explicit caller request wins over everything; an operator poll.model wins
// over the tier chain. Both are configuration, so both outrank the default.
func TestPollModelSelectionPrecedence(t *testing.T) {
	writeTierConfig(t, map[string]string{"fast": "fast-model"})

	requested := &Manager{config: &types.EngineRuntimeConfig{DefaultModel: "default-model"}}
	if got := selectPollModel(requested, requested.pollConfig(), tools.PollRequest{Model: "caller-model"}); got != "caller-model" {
		t.Errorf("caller request = %q, want %q", got, "caller-model")
	}

	operator := &Manager{config: &types.EngineRuntimeConfig{
		DefaultModel: "default-model",
		Poll:         &types.PollConfig{Model: "operator-model"},
	}}
	if got := selectPollModel(operator, operator.pollConfig(), tools.PollRequest{}); got != "operator-model" {
		t.Errorf("operator config = %q, want %q", got, "operator-model")
	}
}
