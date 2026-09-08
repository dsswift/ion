//go:build windows

package utils

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A credential keyfile written with mode 0o600 is not protected on Windows:
// os.Chmod there toggles the read-only attribute and nothing else, so the
// file inherits the profile directory's ACL, which grants
// BUILTIN\Administrators full control. The key sits beside the ciphertext it
// decrypts, so that makes the encryption decorative while the code comment
// claims 0600.
func TestRestrictToOwner_RemovesInheritedGrants(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.key")
	if err := os.WriteFile(path, []byte("secret-key-material"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := RestrictToOwner(path); err != nil {
		t.Fatalf("RestrictToOwner: %v", err)
	}

	out, err := exec.Command("icacls.exe", path).CombinedOutput()
	if err != nil {
		t.Fatalf("icacls: %v: %s", err, out)
	}
	acl := string(out)

	for _, trustee := range []string{"BUILTIN\\Administrators", "NT AUTHORITY\\SYSTEM"} {
		if strings.Contains(acl, trustee) {
			t.Errorf("ACL still grants %s after RestrictToOwner:\n%s", trustee, acl)
		}
	}
	// The owner must retain access, or the engine locks itself out of its own
	// credential store.
	if !strings.Contains(acl, os.Getenv("USERNAME")) {
		t.Errorf("ACL does not grant the owner (%s):\n%s", os.Getenv("USERNAME"), acl)
	}
	// Inheritance must be off, or the parent's grants come straight back.
	if strings.Contains(acl, "(I)") {
		t.Errorf("ACL still carries inherited entries:\n%s", acl)
	}
}

// The file must still be readable and writable by the process that owns it.
func TestRestrictToOwner_OwnerRetainsAccess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.enc")
	if err := os.WriteFile(path, []byte("ciphertext"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RestrictToOwner(path); err != nil {
		t.Fatalf("RestrictToOwner: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("owner cannot read after restriction: %v", err)
	}
	if string(got) != "ciphertext" {
		t.Errorf("content = %q, want %q", got, "ciphertext")
	}
	if err := os.WriteFile(path, []byte("rewritten"), 0o600); err != nil {
		t.Fatalf("owner cannot write after restriction: %v", err)
	}
}

// A missing file must produce an error rather than a silent success: the
// caller is about to treat the path as a protected secret store.
func TestRestrictToOwner_MissingFileErrors(t *testing.T) {
	if err := RestrictToOwner(filepath.Join(t.TempDir(), "nope.key")); err == nil {
		t.Error("RestrictToOwner on a missing file returned nil")
	}
}
