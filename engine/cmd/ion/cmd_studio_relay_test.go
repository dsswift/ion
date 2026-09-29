package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func readServerJSON(t *testing.T, dir string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "server.json"))
	if err != nil {
		t.Fatalf("read server.json: %v", err)
	}
	cfg := map[string]any{}
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("parse server.json: %v", err)
	}
	return cfg
}

// An install that already exists gains a relay, and nothing else in its
// server.json moves. `install --relay` cannot do this: it never rewrites an
// existing file.
func TestSetStudioRelay_AddsToAnExistingInstallAndKeepsEveryOtherKey(t *testing.T) {
	dir := t.TempDir()
	original := `{"label":"lab","tenancy":{"mode":"shared"},"somethingNew":{"keep":true}}`
	if err := os.WriteFile(filepath.Join(dir, "server.json"), []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	changed, err := setStudioRelay(dir, studioRelayEntry{url: "wss://relay.example.org", psk: "k1"})
	if err != nil || !changed {
		t.Fatalf("set: changed=%v err=%v", changed, err)
	}
	cfg := readServerJSON(t, dir)
	if cfg["label"] != "lab" || cfg["somethingNew"].(map[string]any)["keep"] != true {
		t.Errorf("other keys were not preserved: %v", cfg)
	}
	relays := studioRelaysOf(cfg)
	if len(relays) != 1 || relays[0] != (studioRelayEntry{url: "wss://relay.example.org", psk: "k1"}) {
		t.Errorf("relays = %+v", relays)
	}

	// The same entry again changes nothing, so nothing restarts.
	if changed, err := setStudioRelay(dir, relays[0]); err != nil || changed {
		t.Errorf("identical set: changed=%v err=%v, want unchanged", changed, err)
	}
	// The same URL with a different auth replaces the entry rather than adding one.
	if changed, err := setStudioRelay(dir, studioRelayEntry{url: "wss://relay.example.org", oidc: true}); err != nil || !changed {
		t.Fatalf("replace: changed=%v err=%v", changed, err)
	}
	raw := readServerJSON(t, dir)["relays"].([]any)
	if len(raw) != 1 {
		t.Fatalf("relays = %v, want the one entry replaced", raw)
	}
	entry := raw[0].(map[string]any)
	if entry["auth"] != "oidc" || entry["psk"] != nil {
		t.Errorf("an oidc entry must carry auth:oidc and no psk: %v", entry)
	}
}

func TestSetStudioRelay_CreatesServerJSONOnADesktopInstall(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fresh")
	if _, err := setStudioRelay(dir, studioRelayEntry{url: "wss://relay.example.org", oidc: true}); err != nil {
		t.Fatalf("set: %v", err)
	}
	cfg := readServerJSON(t, dir)
	if len(cfg) != 1 {
		t.Errorf("a created server.json must state only the relays, so every other default stays the server's: %v", cfg)
	}
	info, err := os.Stat(filepath.Join(dir, "server.json"))
	// Windows file modes carry only read-only; the profile's ACL keeps it private.
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Errorf("server.json mode = %v (err %v), want 0600: it can hold a key", info.Mode().Perm(), err)
	}
}

func TestSetStudioRelay_LeavesAnUnparseableFileAlone(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "server.json")
	if err := os.WriteFile(path, []byte(`{"label": `), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := setStudioRelay(dir, studioRelayEntry{url: "wss://relay.example.org", oidc: true}); err == nil {
		t.Fatal("expected an error")
	}
	if data, _ := os.ReadFile(path); string(data) != `{"label": ` { //nolint:errcheck // asserted via content
		t.Errorf("the file was rewritten: %q", data)
	}
}

func TestRemoveStudioRelay(t *testing.T) {
	dir := t.TempDir()
	for _, e := range []studioRelayEntry{{url: "wss://a.example", psk: "k"}, {url: "wss://b.example", oidc: true}} {
		if _, err := setStudioRelay(dir, e); err != nil {
			t.Fatal(err)
		}
	}
	if changed, err := removeStudioRelay(dir, "wss://a.example/"); err != nil || !changed {
		t.Fatalf("remove: changed=%v err=%v", changed, err)
	}
	if relays, _ := readStudioRelays(dir); len(relays) != 1 || relays[0].url != "wss://b.example" { //nolint:errcheck // asserted via content
		t.Errorf("relays = %+v", relays)
	}
	if changed, err := removeStudioRelay(dir, "wss://never.example"); err != nil || changed {
		t.Errorf("removing an unknown relay: changed=%v err=%v", changed, err)
	}
}

// The key arrives on standard input or in a file, never as an argument.
func TestStudioRelayEntryFromFlags(t *testing.T) {
	entry, err := studioRelayEntryFromFlags("wss://relay.example.org/", map[string]string{"key-stdin": "true"}, strings.NewReader("  the-key  \nignored\n"))
	if err != nil || entry != (studioRelayEntry{url: "wss://relay.example.org", psk: "the-key"}) {
		t.Errorf("stdin: entry=%+v err=%v", entry, err)
	}

	keyFile := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyFile, []byte("file-key\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if entry, err := studioRelayEntryFromFlags("wss://r.example", map[string]string{"key-file": keyFile}, strings.NewReader("")); err != nil || entry.psk != "file-key" {
		t.Errorf("file: entry=%+v err=%v", entry, err)
	}
	if entry, err := studioRelayEntryFromFlags("wss://r.example", map[string]string{"oidc": "true"}, strings.NewReader("")); err != nil || !entry.oidc || entry.psk != "" {
		t.Errorf("oidc: entry=%+v err=%v", entry, err)
	}

	for name, tc := range map[string]struct {
		url   string
		flags map[string]string
		stdin string
	}{
		"no auth chosen":  {"wss://r.example", map[string]string{}, ""},
		"two auths":       {"wss://r.example", map[string]string{"oidc": "true", "key-stdin": "true"}, "k"},
		"empty key":       {"wss://r.example", map[string]string{"key-stdin": "true"}, "\n"},
		"not a relay url": {"https://r.example", map[string]string{"oidc": "true"}, ""},
	} {
		if _, err := studioRelayEntryFromFlags(tc.url, tc.flags, strings.NewReader(tc.stdin)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}
