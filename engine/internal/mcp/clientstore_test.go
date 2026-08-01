package mcp

// clientstore_test.go — behavior pins for the OAuth client registration store.
//
// The store holds the client_id an authorization server minted for this
// machine. Losing it silently means the next login registers a second client
// and orphans the first with the provider, so round-trip fidelity, restrictive
// file mode, and corrupt-file survival all matter.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestClientStore_RoundTrip(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	store := NewClientStore()
	reg := &ClientRegistration{
		ClientID:     "client-abc",
		ClientSecret: "shh",
		Issuer:       "https://auth.example.test",
		AuthURL:      "https://auth.example.test/authorize",
		TokenURL:     "https://auth.example.test/token",
		Scope:        "openid email",
		RedirectURI:  "http://127.0.0.1:51234/mcp/callback",
		RegisteredAt: time.Now().Truncate(time.Second),
	}
	store.Set("srv", reg)

	// A fresh store reads what the first one wrote.
	reloaded := NewClientStore()
	got := reloaded.Get("srv")
	if got == nil {
		t.Fatal("registration did not survive a store reload")
	}
	if got.ClientID != reg.ClientID || got.ClientSecret != reg.ClientSecret {
		t.Errorf("client identity did not round-trip: %+v", got)
	}
	if got.AuthURL != reg.AuthURL || got.TokenURL != reg.TokenURL {
		t.Errorf("endpoints did not round-trip: %+v", got)
	}
	if got.RedirectURI != reg.RedirectURI {
		t.Errorf("redirect uri = %q; it is bound to the client_id and must persist", got.RedirectURI)
	}
	if got.Scope != reg.Scope {
		t.Errorf("scope = %q, want %q", got.Scope, reg.Scope)
	}
}

func TestClientStore_FileModeIsOwnerOnly(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	NewClientStore().Set("srv", &ClientRegistration{ClientID: "c", AuthURL: "a", TokenURL: "t"})

	path := filepath.Join(home, ".ion", "mcp-clients.json")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat store: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("store file mode = %o, want 600; it can hold a client_secret", perm)
	}

	dirInfo, err := os.Stat(filepath.Join(home, ".ion"))
	if err != nil {
		t.Fatalf("stat dir: %v", err)
	}
	if perm := dirInfo.Mode().Perm(); perm != 0o700 {
		t.Errorf("store directory mode = %o, want 700", perm)
	}
}

func TestClientStore_Delete(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	store := NewClientStore()
	store.Set("keep", &ClientRegistration{ClientID: "k", AuthURL: "a", TokenURL: "t"})
	store.Set("drop", &ClientRegistration{ClientID: "d", AuthURL: "a", TokenURL: "t"})
	store.Delete("drop")

	reloaded := NewClientStore()
	if reloaded.Get("drop") != nil {
		t.Error("deleted registration still present after reload")
	}
	if reloaded.Get("keep") == nil {
		t.Error("delete removed the wrong registration")
	}
}

// TestClientStore_CorruptFileRecovers pins that a truncated or hand-mangled
// store leaves a usable (empty) store rather than panicking on a nil map at the
// next Set.
func TestClientStore_CorruptFileRecovers(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	ionDir := filepath.Join(home, ".ion")
	if err := os.MkdirAll(ionDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(ionDir, "mcp-clients.json"), []byte(`{"srv": {truncated`), 0o600); err != nil {
		t.Fatalf("write corrupt store: %v", err)
	}

	store := NewClientStore()
	if store.Get("srv") != nil {
		t.Error("a corrupt store must not yield registrations")
	}
	// Must not panic: the map has to still be allocated.
	store.Set("srv", &ClientRegistration{ClientID: "fresh", AuthURL: "a", TokenURL: "t"})
	if got := store.Get("srv"); got == nil || got.ClientID != "fresh" {
		t.Error("store must be writable after recovering from a corrupt file")
	}
}

// TestClientStore_NullFileDoesNotNilMap pins the `null` case specifically: it
// decodes without error to a nil map, which would panic on assignment if the
// allocated map were replaced.
func TestClientStore_NullFileDoesNotNilMap(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	ionDir := filepath.Join(home, ".ion")
	if err := os.MkdirAll(ionDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(ionDir, "mcp-clients.json"), []byte(`null`), 0o600); err != nil {
		t.Fatalf("write null store: %v", err)
	}

	store := NewClientStore()
	store.Set("srv", &ClientRegistration{ClientID: "c", AuthURL: "a", TokenURL: "t"})
	if store.Get("srv") == nil {
		t.Error("store built from a null file must accept writes")
	}
}

func TestClientStore_Names(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	store := NewClientStore()
	store.Set("a", &ClientRegistration{ClientID: "1", AuthURL: "x", TokenURL: "y"})
	store.Set("b", &ClientRegistration{ClientID: "2", AuthURL: "x", TokenURL: "y"})

	names := store.Names()
	if len(names) != 2 {
		t.Fatalf("Names() = %v, want two entries", names)
	}
}

// TestClientStore_PersistedShapeIsStable pins the on-disk JSON keys. The file
// is operator-inspectable and survives upgrades, so a field rename would
// silently drop a stored client.
func TestClientStore_PersistedShapeIsStable(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	NewClientStore().Set("srv", &ClientRegistration{
		ClientID: "c", AuthURL: "https://a", TokenURL: "https://t",
		RedirectURI: "http://127.0.0.1:5000/mcp/callback",
	})

	data, err := os.ReadFile(filepath.Join(home, ".ion", "mcp-clients.json"))
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	var raw map[string]map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("stored file is not valid JSON: %v", err)
	}
	entry, ok := raw["srv"]
	if !ok {
		t.Fatal("stored file is not keyed by server name")
	}
	for _, key := range []string{"client_id", "auth_url", "token_url", "redirect_uri"} {
		if _, present := entry[key]; !present {
			t.Errorf("stored entry is missing key %q", key)
		}
	}
	// An empty secret must not be written — the file is read by operators and
	// an empty client_secret key implies a confidential client that is not one.
	if _, present := entry["client_secret"]; present {
		t.Error("empty client_secret must be omitted from the persisted shape")
	}
}
