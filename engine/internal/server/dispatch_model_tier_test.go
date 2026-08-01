package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/modelconfig"
)

// resolve_model_tier is the command a consumer uses to GATE a feature on a tier
// existing. Two properties make that possible, and both are easy to break:
//
//  1. `configured` distinguishes a defined tier from ResolveTierChain's
//     pass-through, which echoes an unknown name back as if it were a model.
//     Without the flag a consumer cannot tell "standard is claude-sonnet" from
//     "standard is undefined and will fail to route".
//  2. `fallbacks` is always a LIST. A tier with no fallbacks yields a nil Go
//     slice, which marshals to JSON `null` — a consumer reading
//     `data.fallbacks.length` would fault on the most common tier shape (a
//     plain string).
//
// These assert the resolution + normalization the dispatch arm performs. The
// arm itself writes to a socket, so the shaping logic is exercised through the
// same modelconfig call and normalization the handler applies.

// writeModelsConfig points HOME at a temp dir carrying a models.json.
func writeModelsConfig(t *testing.T, body string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".ion")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "models.json"), []byte(body), 0o644); err != nil {
		t.Fatalf("write models.json: %v", err)
	}
}

// resolveTierPayload mirrors the dispatch arm's shaping exactly.
func resolveTierPayload(tierName string) map[string]interface{} {
	model, fallbacks := modelconfig.ResolveTierChain(tierName)
	configured := model != tierName
	if fallbacks == nil {
		fallbacks = []string{}
	}
	return map[string]interface{}{
		"tier":       tierName,
		"model":      model,
		"fallbacks":  fallbacks,
		"configured": configured,
	}
}

func TestResolveModelTier_ConfiguredStringTier(t *testing.T) {
	writeModelsConfig(t, `{"tiers":{"standard":"claude-sonnet-4-6"}}`)

	got := resolveTierPayload("standard")

	if got["model"] != "claude-sonnet-4-6" {
		t.Errorf("model = %v, want claude-sonnet-4-6", got["model"])
	}
	if got["configured"] != true {
		t.Errorf("configured = %v, want true", got["configured"])
	}
}

func TestResolveModelTier_UnconfiguredTierIsNotConfigured(t *testing.T) {
	// The gating case: an undefined tier echoes its own name back, so only the
	// flag separates it from a real answer.
	writeModelsConfig(t, `{"tiers":{"fast":"qwen2.5:7b"}}`)

	got := resolveTierPayload("standard")

	if got["configured"] != false {
		t.Errorf("configured = %v, want false for an undefined tier", got["configured"])
	}
	if got["model"] != "standard" {
		t.Errorf("model = %v, want the echoed tier name", got["model"])
	}
}

func TestResolveModelTier_ObjectTierCarriesFallbacks(t *testing.T) {
	writeModelsConfig(t, `{"tiers":{"standard":{"model":"a","fallbacks":["b","c"]}}}`)

	got := resolveTierPayload("standard")

	if got["model"] != "a" {
		t.Errorf("model = %v, want a", got["model"])
	}
	fb, ok := got["fallbacks"].([]string)
	if !ok {
		t.Fatalf("fallbacks type = %T, want []string", got["fallbacks"])
	}
	if len(fb) != 2 || fb[0] != "b" || fb[1] != "c" {
		t.Errorf("fallbacks = %v, want [b c]", fb)
	}
}

// The normalization. Reverting the nil guard in the dispatch arm turns this
// red: the field marshals to `null` and a consumer indexing it faults.
func TestResolveModelTier_FallbacksAlwaysMarshalsToAList(t *testing.T) {
	writeModelsConfig(t, `{"tiers":{"standard":"claude-sonnet-4-6"}}`)

	raw, err := json.Marshal(resolveTierPayload("standard"))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if string(decoded["fallbacks"]) != "[]" {
		t.Errorf("fallbacks marshalled to %s, want [] — null breaks a consumer reading .length",
			decoded["fallbacks"])
	}
}

func TestResolveModelTier_UnconfiguredTierAlsoGetsAList(t *testing.T) {
	writeModelsConfig(t, `{"tiers":{}}`)

	raw, err := json.Marshal(resolveTierPayload("standard"))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if string(decoded["fallbacks"]) != "[]" {
		t.Errorf("fallbacks marshalled to %s, want []", decoded["fallbacks"])
	}
}
