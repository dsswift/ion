//go:build windows

package auth

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// widenACL grants BUILTIN\Administrators full control, reproducing what a
// file inherits from the user profile directory when nothing narrows it.
func widenACL(t *testing.T, path string) {
	t.Helper()
	if out, err := exec.Command("icacls.exe", path, "/grant", "*S-1-5-32-544:(F)").CombinedOutput(); err != nil {
		t.Fatalf("icacls grant: %v: %s", err, out)
	}
}

func aclOf(t *testing.T, path string) string {
	t.Helper()
	out, err := exec.Command("icacls.exe", path).CombinedOutput()
	if err != nil {
		t.Fatalf("icacls: %v: %s", err, out)
	}
	return string(out)
}

// The narrowing has to apply to files that ALREADY EXIST, not only to ones
// the process creates.
//
// The first version of this ran RestrictToOwner solely on the creation path.
// On a machine whose keyfile predated the change, that path never executed
// again, so the file kept BUILTIN\Administrators:(I)(F) indefinitely --
// observed on the operator's VM after the fix had supposedly shipped. The
// engine reads the keyfile on every start, so the read path is what has to
// carry the repair.
func TestFileStore_NarrowsPreexistingKeyfile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	fs := &FileStore{
		path:    filepath.Join(dir, ".ion", "credentials.enc"),
		keyPath: filepath.Join(dir, ".ion", "credentials.key"),
	}
	if err := os.MkdirAll(filepath.Join(dir, ".ion"), 0o700); err != nil {
		t.Fatal(err)
	}

	// First load creates the keyfile.
	if _, err := fs.loadOrCreateKeyfile(); err != nil {
		t.Fatalf("create keyfile: %v", err)
	}
	widenACL(t, fs.keyPath)
	if !strings.Contains(aclOf(t, fs.keyPath), "BUILTIN\\Administrators") {
		t.Fatal("precondition failed: the ACL was not widened")
	}

	// Second load must repair the ACL of the file it finds.
	if _, err := fs.loadOrCreateKeyfile(); err != nil {
		t.Fatalf("reload keyfile: %v", err)
	}

	if acl := aclOf(t, fs.keyPath); strings.Contains(acl, "BUILTIN\\Administrators") {
		t.Errorf("pre-existing keyfile still grants Administrators after load:\n%s", acl)
	}
}

// Same for the ciphertext. A store that is only ever read is never
// rewritten, so the write path cannot be the only place this happens.
func TestFileStore_NarrowsPreexistingCredentialsFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	fs := &FileStore{
		path:    filepath.Join(dir, ".ion", "credentials.enc"),
		keyPath: filepath.Join(dir, ".ion", "credentials.key"),
	}
	if err := os.MkdirAll(filepath.Join(dir, ".ion"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := fs.SetKey("test-provider", "sk-value"); err != nil {
		t.Fatalf("seed store: %v", err)
	}

	widenACL(t, fs.path)
	if _, _, err := fs.readFile(); err != nil {
		t.Fatalf("readFile: %v", err)
	}

	if acl := aclOf(t, fs.path); strings.Contains(acl, "BUILTIN\\Administrators") {
		t.Errorf("pre-existing credentials file still grants Administrators after read:\n%s", acl)
	}
}
