package extension

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// hashOf returns the hex SHA-256 of content, matching hashFile's encoding.
func hashOf(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// TestCheckExtensionAllowlist_EmptyMeansNoRestriction pins that an empty
// allowlist permits every extension (unchanged default behavior).
func TestCheckExtensionAllowlist_EmptyMeansNoRestriction(t *testing.T) {
	if err := checkExtensionAllowlist("anything", "/nonexistent", nil); err != nil {
		t.Errorf("empty allowlist must permit any extension, got %v", err)
	}
	if err := checkExtensionAllowlist("anything", "/nonexistent", []types.ExtensionAllowlistEntry{}); err != nil {
		t.Errorf("empty (non-nil) allowlist must permit any extension, got %v", err)
	}
}

// TestCheckExtensionAllowlist_AllowedByName pins that a listed identifier with
// no pinned hash loads.
func TestCheckExtensionAllowlist_AllowedByName(t *testing.T) {
	allow := []types.ExtensionAllowlistEntry{{ID: "ion-meta"}}
	if err := checkExtensionAllowlist("ion-meta", "/whatever", allow); err != nil {
		t.Errorf("listed extension must load, got %v", err)
	}
}

// TestCheckExtensionAllowlist_NotListedBlocked pins that an unlisted identifier
// is blocked with ErrExtensionBlocked (reason name).
func TestCheckExtensionAllowlist_NotListedBlocked(t *testing.T) {
	allow := []types.ExtensionAllowlistEntry{{ID: "ion-meta"}}
	err := checkExtensionAllowlist("rogue-ext", "/whatever", allow)
	if err == nil {
		t.Fatal("unlisted extension must be blocked")
	}
	if !errors.Is(err, ErrExtensionBlocked) {
		t.Errorf("error must wrap ErrExtensionBlocked, got %v", err)
	}
}

// TestCheckExtensionAllowlist_HashMatchPasses pins integrity verification: a
// listed extension whose entry-point hash matches the pinned SHA256 loads.
func TestCheckExtensionAllowlist_HashMatchPasses(t *testing.T) {
	dir := t.TempDir()
	entry := filepath.Join(dir, "extension.ts")
	const body = "// pinned content"
	if err := os.WriteFile(entry, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	allow := []types.ExtensionAllowlistEntry{{ID: "pinned", SHA256: hashOf(body)}}
	if err := checkExtensionAllowlist("pinned", entry, allow); err != nil {
		t.Errorf("matching hash must pass, got %v", err)
	}
}

// TestCheckExtensionAllowlist_HashMismatchBlocked pins that a tampered entry
// point (hash differs from the pin) is blocked with reason hash.
func TestCheckExtensionAllowlist_HashMismatchBlocked(t *testing.T) {
	dir := t.TempDir()
	entry := filepath.Join(dir, "extension.ts")
	if err := os.WriteFile(entry, []byte("// tampered content"), 0o644); err != nil {
		t.Fatal(err)
	}
	allow := []types.ExtensionAllowlistEntry{{ID: "pinned", SHA256: hashOf("// original content")}}
	err := checkExtensionAllowlist("pinned", entry, allow)
	if err == nil {
		t.Fatal("hash mismatch must be blocked")
	}
	if !errors.Is(err, ErrExtensionBlocked) {
		t.Errorf("error must wrap ErrExtensionBlocked, got %v", err)
	}
}

// TestCheckExtensionAllowlist_CaseInsensitiveHash pins that hex hash comparison
// is case-insensitive (a pin in uppercase still matches).
func TestCheckExtensionAllowlist_CaseInsensitiveHash(t *testing.T) {
	dir := t.TempDir()
	entry := filepath.Join(dir, "extension.ts")
	const body = "// content"
	if err := os.WriteFile(entry, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	upper := ""
	for _, c := range hashOf(body) {
		if c >= 'a' && c <= 'f' {
			upper += string(c - 32)
		} else {
			upper += string(c)
		}
	}
	allow := []types.ExtensionAllowlistEntry{{ID: "pinned", SHA256: upper}}
	if err := checkExtensionAllowlist("pinned", entry, allow); err != nil {
		t.Errorf("uppercase pinned hash must match, got %v", err)
	}
}

// TestCheckExtensionAllowlist_ListedNoHashSkipsVerification pins that a listed
// entry without a SHA256 loads regardless of file content.
func TestCheckExtensionAllowlist_ListedNoHashSkipsVerification(t *testing.T) {
	allow := []types.ExtensionAllowlistEntry{{ID: "ion-meta"}}
	// entryPath is never read when no hash is pinned.
	if err := checkExtensionAllowlist("ion-meta", "/does/not/exist", allow); err != nil {
		t.Errorf("listed extension without a pinned hash must load, got %v", err)
	}
}

// TestHostLoad_BlockedExtension_ReturnsErrExtensionBlocked pins the full load
// path: Host.Load with a restrictive allowlist blocks a non-listed extension
// before spawning, and the returned error is ErrExtensionBlocked. Red on
// unfixed code (Load would spawn the subprocess).
func TestHostLoad_BlockedExtension_ReturnsErrExtensionBlocked(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "index.js"), minimalExtensionSrc)

	h := NewHost()
	defer h.Dispose()

	cfg := &ExtensionConfig{
		ExtensionAllowlist: []types.ExtensionAllowlistEntry{{ID: "only-this-one"}},
	}
	// The directory basename is the identifier; it will not equal "only-this-one".
	err := h.Load(filepath.Join(dir, "index.js"), cfg)
	if err == nil {
		t.Fatal("Load must block a non-allowlisted extension")
	}
	if !errors.Is(err, ErrExtensionBlocked) {
		t.Errorf("Load error must wrap ErrExtensionBlocked, got %v", err)
	}
}

// TestHostLoad_ReloadBlockedIdentically pins that a second Load call (the
// re-registration / hot-reload path) enforces the allowlist the same way.
func TestHostLoad_ReloadBlockedIdentically(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "index.js"), minimalExtensionSrc)

	cfg := &ExtensionConfig{
		ExtensionAllowlist: []types.ExtensionAllowlistEntry{{ID: "only-this-one"}},
	}
	for i := 0; i < 2; i++ {
		h := NewHost()
		err := h.Load(filepath.Join(dir, "index.js"), cfg)
		h.Dispose()
		if !errors.Is(err, ErrExtensionBlocked) {
			t.Errorf("load %d: error must wrap ErrExtensionBlocked, got %v", i, err)
		}
	}
}
