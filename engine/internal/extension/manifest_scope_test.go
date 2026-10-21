package extension

import (
	"os"
	"path/filepath"
	"testing"
)

func TestManifestScope(t *testing.T) {
	cases := []struct {
		name string
		body string
		want ManifestScope
		err  bool
	}{
		{"absent", `{}`, ManifestScopeSession, false},
		{"session", `{"scope":"session"}`, ManifestScopeSession, false},
		{"engine", `{"scope":"engine"}`, ManifestScopeEngine, false},
		{"both", `{"scope":"both"}`, ManifestScopeBoth, false},
		{"unknown value", `{"scope":"global"}`, "", true},
		{"wrong type", `{"scope":true}`, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "extension.json"), []byte(tc.body), 0o600); err != nil {
				t.Fatal(err)
			}
			manifest, err := LoadManifest(dir)
			if tc.err {
				if err == nil {
					t.Fatal("LoadManifest succeeded")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := manifest.EffectiveScope(); got != tc.want {
				t.Fatalf("scope = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestManifestScopeNilIsSession(t *testing.T) {
	var m *Manifest
	if m.EffectiveScope() != ManifestScopeSession {
		t.Fatal("nil manifest must be session scope")
	}
	if m.SpawnsEngineHost() || !m.SpawnsSessionHosts() {
		t.Fatal("nil manifest spawns session hosts only")
	}
	both := &Manifest{Scope: ManifestScopeBoth}
	if !both.SpawnsEngineHost() || !both.SpawnsSessionHosts() {
		t.Fatal("both spawns both halves")
	}
	engine := &Manifest{Scope: ManifestScopeEngine}
	if !engine.SpawnsEngineHost() || engine.SpawnsSessionHosts() {
		t.Fatal("engine spawns the engine host only")
	}
}
