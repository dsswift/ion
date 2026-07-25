package auth

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeKeyfileTestStore returns a FileStore rooted in a temp dir with an
// explicit keyfile path, plus the dir for direct file assertions.
func makeKeyfileTestStore(t *testing.T) (*FileStore, string) {
	t.Helper()
	dir := t.TempDir()
	return &FileStore{
		path:    filepath.Join(dir, "credentials.enc"),
		keyPath: filepath.Join(dir, "credentials.key"),
	}, dir
}

// setHostname swaps the hostname seam for the duration of the test.
func setHostname(t *testing.T, name string) {
	t.Helper()
	orig := hostnameFn
	hostnameFn = func() (string, error) { return name, nil }
	t.Cleanup(func() { hostnameFn = orig })
}

// writeLegacyEncrypted writes a credential file encrypted with the legacy
// machine-derived key (as produced by pre-keyfile builds).
func writeLegacyEncrypted(t *testing.T, fs *FileStore, keys map[string]string) {
	t.Helper()
	data, err := json.Marshal(&credentialFile{Version: 1, Keys: keys})
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, err := encryptWithKey(deriveLegacyKey(), string(data))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(fs.path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fs.path, []byte(hex.EncodeToString(ciphertext)), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestFileStore_SurvivesHostnameChange is the regression test for the
// "API key lost after reboot" bug: pre-keyfile builds derived the AES key
// from the hostname, so a DHCP/mDNS rename between boots made the store
// undecryptable. With the keyfile scheme this test passes; with the legacy
// machine-derived scheme it fails.
func TestFileStore_SurvivesHostnameChange(t *testing.T) {
	fs, _ := makeKeyfileTestStore(t)

	setHostname(t, "host-a.local")
	if err := fs.SetKey("anthropic", "sk-ant-persist-me"); err != nil {
		t.Fatal(err)
	}

	// Simulate a reboot that renamed the machine.
	setHostname(t, "host-b-2.lan")
	fs2 := &FileStore{path: fs.path, keyPath: fs.keyPath}

	key, err := fs2.GetKey("anthropic")
	if err != nil {
		t.Fatalf("GetKey after hostname change: %v", err)
	}
	if key != "sk-ant-persist-me" {
		t.Fatalf("expected key to survive hostname change, got %q", key)
	}
}

// TestFileStore_LegacyMigration verifies that a store written by a
// pre-keyfile build (legacy machine-derived key, hostname unchanged) is
// readable and transparently re-encrypted under the keyfile key on first
// read.
func TestFileStore_LegacyMigration(t *testing.T) {
	fs, _ := makeKeyfileTestStore(t)

	setHostname(t, "stable-host.local")
	writeLegacyEncrypted(t, fs, map[string]string{"openai": "sk-legacy-123"})

	key, err := fs.GetKey("openai")
	if err != nil {
		t.Fatalf("GetKey on legacy store: %v", err)
	}
	if key != "sk-legacy-123" {
		t.Fatalf("expected legacy key value, got %q", key)
	}

	// The read must have re-encrypted the store under the keyfile key:
	// after a hostname change (legacy key now useless) the store still reads.
	setHostname(t, "renamed-host.lan")
	fs2 := &FileStore{path: fs.path, keyPath: fs.keyPath}
	key, err = fs2.GetKey("openai")
	if err != nil {
		t.Fatalf("GetKey after migration + hostname change: %v", err)
	}
	if key != "sk-legacy-123" {
		t.Fatalf("expected migrated key value, got %q", key)
	}
}

// TestFileStore_UndecryptableFile pins the failure mode when neither the
// keyfile key nor the legacy key decrypts the store: reads error (no
// garbage), and a write preserves the old file as a timestamped backup
// instead of silently destroying it.
func TestFileStore_UndecryptableFile(t *testing.T) {
	fs, dir := makeKeyfileTestStore(t)

	setHostname(t, "current-host")

	// Encrypt with a foreign random key (models a legacy store sealed under
	// a hostname that no longer exists).
	foreign := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, foreign); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(&credentialFile{Version: 1, Keys: map[string]string{"anthropic": "sk-lost"}})
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, err := encryptWithKey(foreign, string(data))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fs.path, []byte(hex.EncodeToString(ciphertext)), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := fs.GetKey("anthropic"); err == nil {
		t.Fatal("expected error reading undecryptable store")
	}

	// SetKey must preserve the undecryptable file as a backup, then succeed.
	if err := fs.SetKey("anthropic", "sk-fresh"); err != nil {
		t.Fatalf("SetKey on undecryptable store: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	backupFound := false
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "credentials.enc.bak-") {
			backupFound = true
		}
	}
	if !backupFound {
		t.Fatal("expected undecryptable store preserved as credentials.enc.bak-<ts>")
	}

	key, err := fs.GetKey("anthropic")
	if err != nil {
		t.Fatal(err)
	}
	if key != "sk-fresh" {
		t.Fatalf("expected fresh key after recovery, got %q", key)
	}
}

// TestFileStore_KeyfileCreatedWithPermissions verifies the keyfile is
// created on first write, holds a 32-byte hex key, and is 0600.
func TestFileStore_KeyfileCreatedWithPermissions(t *testing.T) {
	fs, _ := makeKeyfileTestStore(t)

	if _, err := os.Stat(fs.keyPath); !os.IsNotExist(err) {
		t.Fatalf("keyfile should not exist before first write, stat err: %v", err)
	}

	if err := fs.SetKey("groq", "gk-1"); err != nil {
		t.Fatal(err)
	}

	stat, err := os.Stat(fs.keyPath)
	if err != nil {
		t.Fatalf("keyfile not created: %v", err)
	}
	if mode := stat.Mode() & 0o777; mode != 0o600 {
		t.Errorf("expected keyfile mode 0600, got %04o", mode)
	}

	key, err := readKeyfile(fs.keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(key) != 32 {
		t.Fatalf("expected 32-byte key, got %d", len(key))
	}
}

// TestFileStore_KeyfileStableAcrossInstances verifies two FileStore values
// sharing the same paths use the same keyfile (no regeneration).
func TestFileStore_KeyfileStableAcrossInstances(t *testing.T) {
	fs1, _ := makeKeyfileTestStore(t)
	if err := fs1.SetKey("a", "v1"); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(fs1.keyPath)
	if err != nil {
		t.Fatal(err)
	}

	fs2 := &FileStore{path: fs1.path, keyPath: fs1.keyPath}
	if err := fs2.SetKey("b", "v2"); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(fs1.keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("keyfile regenerated between instances; existing store would be orphaned")
	}

	// Both keys readable through either instance.
	for provider, want := range map[string]string{"a": "v1", "b": "v2"} {
		got, err := fs1.GetKey(provider)
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("provider %q: expected %q, got %q", provider, want, got)
		}
	}
}

// TestFileStore_MalformedKeyfileNotOverwritten verifies a present-but-invalid
// keyfile is never silently regenerated (that would orphan an existing store).
func TestFileStore_MalformedKeyfileNotOverwritten(t *testing.T) {
	fs, _ := makeKeyfileTestStore(t)
	if err := os.WriteFile(fs.keyPath, []byte("not hex at all"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := fs.SetKey("x", "y"); err == nil {
		t.Fatal("expected SetKey to fail on malformed keyfile, not regenerate it")
	}

	data, err := os.ReadFile(fs.keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "not hex at all" {
		t.Fatal("malformed keyfile was overwritten")
	}
}

// TestFileStore_DefaultKeyfilePathSibling verifies FileStore values built
// with only a store path (the pattern used across older tests) derive the
// keyfile as a credentials.key sibling.
func TestFileStore_DefaultKeyfilePathSibling(t *testing.T) {
	dir := t.TempDir()
	fs := &FileStore{path: filepath.Join(dir, "credentials.enc")}

	if err := fs.SetKey("p", "v"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "credentials.key")); err != nil {
		t.Fatalf("expected sibling credentials.key: %v", err)
	}
	got, err := fs.GetKey("p")
	if err != nil {
		t.Fatal(err)
	}
	if got != "v" {
		t.Fatalf("expected %q, got %q", "v", got)
	}
}
