package extension

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManifestIdentity(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"absent", `{}`, ""},
		{"operator", `{"identity":{"required":"operator"}}`, "operator"},
		{"workload", `{"identity":{"required":"workload"}}`, "workload"},
		{"any", `{"identity":{"required":"any"}}`, "any"},
		{"empty", `{"identity":{"required":""}}`, "error"},
		{"unknown value", `{"identity":{"required":"other"}}`, "error"},
		{"wrong type", `{"identity":"operator"}`, "error"},
		{"unknown nested", `{"identity":{"required":"operator","extra":true}}`, "error"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "extension.json"), []byte(tc.body), 0o600); err != nil {
				t.Fatal(err)
			}
			manifest, err := LoadManifest(dir)
			if tc.want == "error" {
				if err == nil {
					t.Fatal("LoadManifest succeeded")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tc.want == "" && manifest.Identity != nil {
				t.Fatalf("identity = %#v", manifest.Identity)
			}
			if tc.want != "" && (manifest.Identity == nil || manifest.Identity.Required != tc.want) {
				t.Fatalf("identity = %#v", manifest.Identity)
			}
		})
	}
}

func TestResolveExtensionPreflightAllOrNothing(t *testing.T) {
	first := t.TempDir()
	if err := os.WriteFile(filepath.Join(first, "extension.ts"), []byte("export {}"), 0o600); err != nil {
		t.Fatal(err)
	}
	last := t.TempDir()
	if err := os.WriteFile(filepath.Join(last, "extension.json"), []byte(`{"identity":{"required":"invalid"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(last, "extension.ts"), []byte("export {}"), 0o600); err != nil {
		t.Fatal(err)
	}
	plans, err := PreflightExtensions([]string{first, last})
	if err == nil {
		t.Fatal("PreflightExtensions succeeded")
	}
	if plans != nil {
		t.Fatalf("plans = %#v, want nil", plans)
	}
	if !strings.Contains(err.Error(), last) {
		t.Fatalf("error %q does not name invalid extension", err)
	}
}
