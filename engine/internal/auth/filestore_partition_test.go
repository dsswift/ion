package auth

import (
	"os"
	"strings"
	"testing"
)

// TestWriteIsPartitioned pins R-37: a credential alice stores is invisible
// to bob's own lookup (GetKeyFor), even though both share the same
// underlying file.
func TestWriteIsPartitioned(t *testing.T) {
	fs, _ := makeKeyfileTestStore(t)

	if err := fs.SetKeyFor("alice", "anthropic", "sk-alice"); err != nil {
		t.Fatal(err)
	}

	got, err := fs.GetKeyFor("alice", "anthropic")
	if err != nil || got != "sk-alice" {
		t.Fatalf("alice's own read = (%q, %v), want (sk-alice, nil)", got, err)
	}

	if _, err := fs.GetKeyFor("bob", "anthropic"); err == nil {
		t.Error("expected bob's read of alice's key to fail")
	}
}

// TestDeleteCannotCrossPartition pins R-37: bob deleting his own (nonexistent
// or real) entry never touches alice's.
func TestDeleteCannotCrossPartition(t *testing.T) {
	fs, _ := makeKeyfileTestStore(t)

	if err := fs.SetKeyFor("alice", "anthropic", "sk-alice"); err != nil {
		t.Fatal(err)
	}
	if err := fs.DeleteKeyFor("bob", "anthropic"); err != nil {
		t.Fatal(err)
	}

	got, err := fs.GetKeyFor("alice", "anthropic")
	if err != nil || got != "sk-alice" {
		t.Errorf("alice's key should survive bob's delete, got (%q, %v)", got, err)
	}
}

// TestListStoredScopedToSubject pins R-38: ListStoredFor(subject) returns
// only that subject's own entries.
func TestListStoredScopedToSubject(t *testing.T) {
	fs, _ := makeKeyfileTestStore(t)

	if err := fs.SetKeyFor("alice", "anthropic", "sk-alice"); err != nil {
		t.Fatal(err)
	}
	if err := fs.SetKeyFor("bob", "openai", "sk-bob"); err != nil {
		t.Fatal(err)
	}

	aliceNames, err := fs.ListFor("alice")
	if err != nil {
		t.Fatal(err)
	}
	if len(aliceNames) != 1 || aliceNames[0] != "anthropic" {
		t.Errorf("alice's partition = %v, want [anthropic]", aliceNames)
	}

	bobNames, err := fs.ListFor("bob")
	if err != nil {
		t.Fatal(err)
	}
	if len(bobNames) != 1 || bobNames[0] != "openai" {
		t.Errorf("bob's partition = %v, want [openai]", bobNames)
	}
}

// TestOAuthGrantPartitioned pins R-39: an "oauth:<provider>" grant name is
// partitioned exactly like a plain provider key.
func TestOAuthGrantPartitioned(t *testing.T) {
	fs, _ := makeKeyfileTestStore(t)

	if err := fs.SetKeyFor("alice", "oauth:anthropic", "grant-alice"); err != nil {
		t.Fatal(err)
	}

	got, err := fs.GetKeyFor("alice", "oauth:anthropic")
	if err != nil || got != "grant-alice" {
		t.Fatalf("alice's oauth grant read = (%q, %v), want (grant-alice, nil)", got, err)
	}
	if _, err := fs.GetKeyFor("bob", "oauth:anthropic"); err == nil {
		t.Error("expected bob's read of alice's oauth grant to fail")
	}
	if _, err := fs.GetKey("oauth:anthropic"); err == nil {
		t.Error("expected the unattributed (unpartitioned) read to fail -- the grant is alice's, not the process's")
	}
}

// TestAttributedDoesNotReadUnattributed pins that an attributed principal
// never falls through to the shared unattributed partition -- the exact
// path child 04's refusal mode exists to close.
func TestAttributedDoesNotReadUnattributed(t *testing.T) {
	fs, _ := makeKeyfileTestStore(t)

	if err := fs.SetKey("anthropic", "sk-unattributed"); err != nil {
		t.Fatal(err)
	}

	if _, err := fs.GetKeyFor("alice", "anthropic"); err == nil {
		t.Error("expected alice's read to miss -- an attributed principal must not fall through to the unattributed partition")
	}
}

// TestUnpartitionedEntriesStillResolve pins B-07..B-10: a store written
// before this program (no subject prefix at all) still resolves through the
// unattributed path with zero rewrite required.
func TestUnpartitionedEntriesStillResolve(t *testing.T) {
	fs, _ := makeKeyfileTestStore(t)

	// Simulate a pre-existing (pre-child-08) entry: written via the
	// unpartitioned SetKey, exactly as every engine before this child did.
	if err := fs.SetKey("anthropic", "sk-legacy"); err != nil {
		t.Fatal(err)
	}

	got, err := fs.GetKey("anthropic")
	if err != nil || got != "sk-legacy" {
		t.Fatalf("legacy unattributed read = (%q, %v), want (sk-legacy, nil)", got, err)
	}
	// GetKeyFor("", ...) is the SAME unattributed path.
	got2, err := fs.GetKeyFor("", "anthropic")
	if err != nil || got2 != "sk-legacy" {
		t.Fatalf("GetKeyFor(\"\", ...) = (%q, %v), want (sk-legacy, nil)", got2, err)
	}
}

// TestCredentialStoreMigration_NoRewrite pins the backward-migration
// promise: writing a NEW principal's partitioned entry must not alter an
// existing unattributed entry's stored value.
func TestCredentialStoreMigration_NoRewrite(t *testing.T) {
	fs, _ := makeKeyfileTestStore(t)

	if err := fs.SetKey("anthropic", "sk-legacy"); err != nil {
		t.Fatal(err)
	}
	if err := fs.SetKeyFor("alice", "anthropic", "sk-alice"); err != nil {
		t.Fatal(err)
	}

	got, err := fs.GetKey("anthropic")
	if err != nil || got != "sk-legacy" {
		t.Errorf("legacy entry mutated by a partitioned write: got (%q, %v), want (sk-legacy, nil)", got, err)
	}
}

// TestOldEngineCanStillReadFile pins that the file is still a plain
// credentialFile{Keys: map[string]string} JSON structure after a
// partitioned write -- an engine binary built before this child (which
// calls fs.readFile()/creds.Keys directly with no partition awareness)
// would still parse it and find its own unpartitioned entries intact.
func TestOldEngineCanStillReadFile(t *testing.T) {
	fs, _ := makeKeyfileTestStore(t)

	if err := fs.SetKey("anthropic", "sk-legacy"); err != nil {
		t.Fatal(err)
	}
	if err := fs.SetKeyFor("alice", "openai", "sk-alice"); err != nil {
		t.Fatal(err)
	}

	creds, _, err := fs.readFile()
	if err != nil {
		t.Fatal(err)
	}
	if creds.Keys["anthropic"] != "sk-legacy" {
		t.Errorf("old-shape read of the unattributed key = %q, want sk-legacy", creds.Keys["anthropic"])
	}
	// The partitioned entry is present under its namespaced key -- an old
	// engine simply doesn't recognize it as belonging to it, which is
	// correct: it was never the old engine's key to read.
	found := false
	for k := range creds.Keys {
		if strings.Contains(k, "openai") && strings.HasPrefix(k, "p/") {
			found = true
		}
	}
	if !found {
		t.Error("expected alice's partitioned entry to be present under a p/ prefixed key")
	}
}

// TestSubjectWithSlashCannotEscapePartition pins the path-escape safety
// requirement: a subject containing "/" must not let alice address bob's
// partition or a bare provider key by constructing a colliding path.
func TestSubjectWithSlashCannotEscapePartition(t *testing.T) {
	fs, _ := makeKeyfileTestStore(t)

	if err := fs.SetKeyFor("bob", "anthropic", "sk-bob"); err != nil {
		t.Fatal(err)
	}

	// A subject literally containing "bob/anthropic" must not resolve to
	// bob's real partitioned entry -- url.PathEscape must encode the "/".
	evilSubject := "x/../p/bob"
	if err := fs.SetKeyFor(evilSubject, "anthropic", "sk-evil"); err != nil {
		t.Fatal(err)
	}

	got, err := fs.GetKeyFor("bob", "anthropic")
	if err != nil || got != "sk-bob" {
		t.Errorf("bob's key was affected by a colliding subject: got (%q, %v), want (sk-bob, nil)", got, err)
	}

	// The evil subject's own value is still retrievable under ITS OWN
	// (escaped) partition, proving nothing was silently dropped either --
	// escaping isolates rather than merely refusing.
	got2, err2 := fs.GetKeyFor(evilSubject, "anthropic")
	if err2 != nil || got2 != "sk-evil" {
		t.Errorf("the escaped subject's own entry should still resolve: got (%q, %v)", got2, err2)
	}
}

// TestListStoredReturnsNoValues pins the secrets gate: ListStoredFor reports
// only provider id and source, never a credential value.
func TestListStoredReturnsNoValues(t *testing.T) {
	tmp := t.TempDir()
	os.Setenv("HOME", tmp) //nolint:errcheck // test isolation, best-effort
	defer os.Unsetenv("HOME")

	r := NewResolver(nil)
	fs := NewFileStore()
	if err := fs.SetKeyFor("alice", "anthropic", "sk-super-secret-value"); err != nil {
		t.Fatal(err)
	}

	creds := r.ListStoredFor("alice")
	for _, c := range creds {
		if strings.Contains(c.Provider, "sk-super-secret-value") || strings.Contains(c.Source, "sk-super-secret-value") {
			t.Fatalf("ListStoredFor leaked a credential value: %+v", c)
		}
	}
}
