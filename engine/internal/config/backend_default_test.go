package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSetBackendIfUnset(t *testing.T) {
	cases := []struct {
		name        string
		initial     string // "" = no file
		wantWrote   bool
		wantBackend string
	}{
		{name: "no file", wantWrote: true, wantBackend: "hybrid"},
		{name: "unset keeps other keys", initial: `{"defaultModel":"m"}`, wantWrote: true, wantBackend: "hybrid"},
		{name: "empty string", initial: `{"backend":""}`, wantWrote: true, wantBackend: "hybrid"},
		{name: "explicit api kept", initial: `{"backend":"api"}`, wantBackend: "api"},
		{name: "explicit cli kept", initial: `{"backend":"cli"}`, wantBackend: "cli"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "engine.json")
			if tc.initial != "" {
				if err := os.WriteFile(path, []byte(tc.initial), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			wrote, _, err := SetBackendIfUnset(path, "hybrid")
			if err != nil {
				t.Fatalf("SetBackendIfUnset: %v", err)
			}
			if wrote != tc.wantWrote {
				t.Errorf("wrote = %v, want %v", wrote, tc.wantWrote)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read engine.json: %v", err)
			}
			var raw map[string]any
			if err := json.Unmarshal(data, &raw); err != nil {
				t.Fatalf("engine.json is not JSON: %v", err)
			}
			if raw["backend"] != tc.wantBackend {
				t.Errorf("backend = %v, want %q", raw["backend"], tc.wantBackend)
			}
			if tc.name == "unset keeps other keys" && raw["defaultModel"] != "m" {
				t.Error("an unrelated key was dropped")
			}
		})
	}
}

func TestSetBackendIfUnset_NonStringIsAnError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.json")
	if err := os.WriteFile(path, []byte(`{"backend":3}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := SetBackendIfUnset(path, "hybrid"); err == nil {
		t.Fatal("a non-string backend must be reported, not overwritten")
	}
}
