package fleet

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/studioclient"
)

// The desktop wrote this value with its own secret store under a fixed key
// (server/src/utils/__tests__/secretStore-fixture.test.ts opens the same
// file). The fleet reads Studio's pairings in this format.
func TestOpenSecretWrittenByTheDesktop(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "shared", "src", "__fixtures__", "desktop-secret-v3.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct{ KeyHex, Plaintext, Sealed string }
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	key, err := hex.DecodeString(fixture.KeyHex)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := openSecret(fixture.Sealed, key)
	if err != nil {
		t.Fatalf("openSecret: %v", err)
	}
	if plain != fixture.Plaintext {
		t.Fatalf("opened %q, want %q", plain, fixture.Plaintext)
	}
	// What the fleet seals opens the same way.
	sealed, err := sealSecret(fixture.Plaintext, key)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := openSecret(sealed, key); err != nil || again != fixture.Plaintext {
		t.Fatalf("round trip = %q, %v", again, err)
	}
	if _, err := openSecret(fixture.Sealed, bytes.Repeat([]byte{1}, 32)); err == nil {
		t.Error("a secret opened under the wrong key")
	}
	if _, err := openSecret("enc:v1:abc", key); err != errLegacySecret {
		t.Errorf("legacy value error = %v", err)
	}
}

const desktopSettings = `{
  "selectedTheme": "dark",
  "deviceId": "device-1",
  "environments": [
    {"kind": "paired", "label": "devbox", "url": "http://devbox.example:7331", "credentialRef": "env-devbox", "via": "lan", "environmentId": "env-devbox", "relayUrls": ["wss://relay.example"], "futureField": {"kept": true}},
    {"kind": "bearer", "label": "Team (shared)", "url": "https://ion.example.org", "oidc": {"issuer": "https://login.example.org/t/v2.0", "audience": "app", "scope": "Studio.Access"}, "environmentId": "env-team"}
  ],
  "environmentViewFilter": "all"
}`

func testCatalog(t *testing.T, settings string) *Catalog {
	t.Helper()
	dir := t.TempDir()
	if settings != "" {
		if err := os.WriteFile(filepath.Join(dir, "desktop.json"), []byte(settings), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return OpenCatalogAt(dir)
}

func TestCatalogKeepsWhatItDoesNotKnow(t *testing.T) {
	c := testCatalog(t, desktopSettings)
	entries, err := c.Entries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Label != "devbox" || entries[0].CredentialKey() != "env-devbox" || entries[1].OIDC == nil || entries[1].CredentialKey() != "env-team" {
		t.Fatalf("entries = %+v", entries)
	}
	entries[0].ManageOnly = true
	entries[0].Deploy = &DeploySettings{SSH: "user@devbox.example", Kind: KindServer}
	if err := c.SetEntries(entries); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(c.settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	var settings map[string]json.RawMessage
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"selectedTheme", "deviceId", "environmentViewFilter"} {
		if _, ok := settings[key]; !ok {
			t.Errorf("setting %q was dropped", key)
		}
	}
	var written []map[string]json.RawMessage
	if err := json.Unmarshal(settings["environments"], &written); err != nil {
		t.Fatal(err)
	}
	var kept bytes.Buffer
	if err := json.Compact(&kept, written[0]["futureField"]); err != nil || kept.String() != `{"kept":true}` {
		t.Errorf("an entry field the fleet does not know was dropped: %s", settings["environments"])
	}
	if string(written[0]["manageOnly"]) != "true" || written[0]["deploy"] == nil {
		t.Errorf("the edit was not written: %s", settings["environments"])
	}
	if _, has := written[1]["manageOnly"]; has {
		t.Errorf("an unset flag was written: %s", settings["environments"])
	}
	if id, err := c.DeviceID(); err != nil || id != "device-1" {
		t.Errorf("DeviceID = %q, %v", id, err)
	}
}

func TestCatalogMintsADeviceIDOnce(t *testing.T) {
	c := testCatalog(t, "")
	first, err := c.DeviceID()
	if err != nil || len(first) != 36 {
		t.Fatalf("DeviceID = %q, %v", first, err)
	}
	if second, _ := c.DeviceID(); second != first { //nolint:errcheck // compared below
		t.Errorf("a second read minted %q, want %q", second, first)
	}
	if entries, err := c.Entries(); err != nil || len(entries) != 0 {
		t.Errorf("entries = %v, %v", entries, err)
	}
}

func TestCatalogSecrets(t *testing.T) {
	c := testCatalog(t, "")
	if _, ok, err := c.Pairing("env-1"); ok || err != nil {
		t.Fatalf("pairing before any = %v, %v", ok, err)
	}
	p := StoredPairing{
		Pairing:         studioclient.Pairing{ClientID: "client-1", SharedSecret: bytes.Repeat([]byte{9}, 32), Relays: []studioclient.Relay{{URL: "wss://relay.example", Auth: studioclient.RelayAuth{Mode: "psk", Key: "k"}}}},
		DirectAddresses: []string{"http://devbox.example:7331"},
	}
	if err := c.PutPairing("env-1", p); err != nil {
		t.Fatal(err)
	}
	if err := c.PutRefreshToken("env-2", "rt-1"); err != nil {
		t.Fatal(err)
	}
	got, ok, err := c.Pairing("env-1")
	if err != nil || !ok || got.ClientID != "client-1" || !bytes.Equal(got.SharedSecret, p.SharedSecret) || len(got.Relays) != 1 || got.Relays[0].Auth.Key != "k" || got.DirectAddresses[0] != "http://devbox.example:7331" {
		t.Fatalf("pairing = %+v, %v, %v", got, ok, err)
	}
	if token, ok, err := c.RefreshToken("env-2"); err != nil || !ok || token != "rt-1" {
		t.Fatalf("refresh token = %q, %v, %v", token, ok, err)
	}
	// A pairing is not a sign-in, and the reverse.
	if _, ok, _ := c.RefreshToken("env-1"); ok { //nolint:errcheck // only presence matters
		t.Error("a pairing read as a sign-in")
	}
	// Nothing secret is on disk in the clear.
	raw, err := os.ReadFile(c.connectionsPath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("client-1")) || bytes.Contains(raw, []byte("rt-1")) {
		t.Errorf("a secret is stored unsealed: %s", raw)
	}
	if err := c.DeleteSecret("env-1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := c.Pairing("env-1"); ok { //nolint:errcheck // only presence matters
		t.Error("the pairing survived its delete")
	}
	if _, ok, _ := c.RefreshToken("env-2"); !ok { //nolint:errcheck // only presence matters
		t.Error("deleting one secret removed another")
	}
}
