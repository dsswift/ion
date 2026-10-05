package modelconfig

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func writeModelsJSON(t *testing.T, content string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ION_ENTERPRISE_CONFIG", "")
	dir := filepath.Join(home, ".ion")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "models.json"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestProviderReferences_NamesTheDefaultAndEveryTierUse(t *testing.T) {
	writeModelsJSON(t, `{
		"defaultModel": "corp/model-a",
		"tiers": {
			"standard": "claude-sonnet-5-5",
			"fast": {"model": "corp/model-b", "fallbacks": ["claude-haiku-4-5"]},
			"reasoning": {"model": "claude-opus-5-5", "fallbacks": ["corp/model-a"]}
		}
	}`)
	got := ProviderReferences("corp")
	want := []string{
		"the default model corp/model-a",
		"the fast tier's model corp/model-b",
		"the reasoning tier's fallback corp/model-a",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ProviderReferences = %q, want %q", got, want)
	}
}

func TestProviderReferences_NoneWhenModelsJSONUsesOtherProviders(t *testing.T) {
	writeModelsJSON(t, `{"defaultModel": "claude-opus-5-5", "defaultProvider": "anthropic", "tiers": {"standard": "claude-sonnet-5-5"}}`)
	if got := ProviderReferences("corp"); len(got) != 0 {
		t.Fatalf("ProviderReferences = %q, want none", got)
	}
}
