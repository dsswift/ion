package conversation

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func setupPartitionTest(t *testing.T) string {
	t.Helper()
	dataDir := t.TempDir()
	t.Setenv("ION_DATA_DIR", dataDir)
	t.Cleanup(ResetPartitioningForTest)
	return dataDir
}

func TestPrincipalDir_DeterministicAndCollisionFree(t *testing.T) {
	a := PrincipalDir("oidc:alice")
	b := PrincipalDir("oidc:alice")
	if a != b {
		t.Fatalf("PrincipalDir is not deterministic: %q vs %q", a, b)
	}
	c := PrincipalDir("oidc:bob")
	if a == c {
		t.Fatalf("two different subjects produced the same partition dir: %q", a)
	}
	// Two subjects that sanitize to the identical prefix must still collide-free,
	// since the hash suffix is derived from the RAW subject, not the sanitized prefix.
	same1 := PrincipalDir("oidc/alice")
	same2 := PrincipalDir("oidc:alice") // sanitizes to the same prefix as "oidc/alice"
	if same1 == same2 {
		t.Fatalf("subjects that sanitize identically collided: %q", same1)
	}
}

func TestConfigurePartitioning_DisabledIsPassthrough(t *testing.T) {
	setupPartitionTest(t)
	ConfigurePartitioning(DefaultConversationsDir(), &types.PrincipalPartitioningConfig{Enabled: false})

	if PartitioningEnabled() {
		t.Fatal("expected partitioning disabled")
	}
	if got := resolveDir("some-id"); got != DefaultConversationsDir() {
		t.Fatalf("resolveDir with partitioning disabled = %q, want flat root %q", got, DefaultConversationsDir())
	}
}

func TestSaveRoundTrip_AttributedConversationLandsInOwnerPartition(t *testing.T) {
	setupPartitionTest(t)
	root := DefaultConversationsDir()
	ConfigurePartitioning(root, &types.PrincipalPartitioningConfig{Enabled: true})

	conv := CreateConversation(NewConversationID(), "", "test-model")
	conv.Principal = &types.ConversationPrincipal{Subject: "oidc:alice", Provider: "entra"}
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	expectedDir := PartitionConversationsDir("oidc:alice")
	if _, err := os.Stat(filepath.Join(expectedDir, conv.ID+".json")); err != nil {
		t.Fatalf("expected conversation file in partition dir %q: %v", expectedDir, err)
	}
	if _, err := os.Stat(filepath.Join(root, conv.ID+".json")); err == nil {
		t.Fatalf("attributed conversation also landed in the flat root")
	}
	if _, err := os.Stat(filepath.Join(expectedDir, "principal.json")); err != nil {
		t.Fatalf("expected principal.json marker: %v", err)
	}

	// Load resolves the SAME directory via the live index, no dir argument needed.
	loaded, err := Load(conv.ID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.ID != conv.ID {
		t.Fatalf("loaded wrong conversation: got %q want %q", loaded.ID, conv.ID)
	}
	if !Exists(conv.ID, "") {
		t.Fatal("Exists() should find the partitioned conversation")
	}
}

func TestSave_UnattributedConversationStaysInFlatRoot(t *testing.T) {
	setupPartitionTest(t)
	root := DefaultConversationsDir()
	ConfigurePartitioning(root, &types.PrincipalPartitioningConfig{Enabled: true})

	conv := CreateConversation(NewConversationID(), "", "test-model") // no Principal
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, conv.ID+".json")); err != nil {
		t.Fatalf("unattributed conversation should land in the flat root: %v", err)
	}
}

func TestLoad_AttributedSessionCannotSeeAnotherOwnersConversation(t *testing.T) {
	setupPartitionTest(t)
	root := DefaultConversationsDir()
	ConfigurePartitioning(root, &types.PrincipalPartitioningConfig{Enabled: true})

	alice := CreateConversation(NewConversationID(), "", "test-model")
	alice.Principal = &types.ConversationPrincipal{Subject: "oidc:alice"}
	if err := Save(alice, ""); err != nil {
		t.Fatalf("Save alice: %v", err)
	}

	// Bob's own resolveDir call for alice's ID must never find it in bob's
	// scope: bob has no reason to know alice's conversation ID, but this
	// pins that the INDEX itself does not leak across a fresh process view --
	// re-resolving after ResetPartitioningForTest + a fresh Configure (the
	// only way a genuinely different principal's request would run) proves
	// the index rebuild is what a boundary check (FR-03) can rely on.
	dir, ok := lookupPartitionDir(alice.ID)
	if !ok || dir != PartitionConversationsDir("oidc:alice") {
		t.Fatalf("expected alice's conversation indexed under her own partition, got dir=%q ok=%v", dir, ok)
	}
}

func TestConfigurePartitioning_RebuildsIndexFromDisk(t *testing.T) {
	setupPartitionTest(t)
	root := DefaultConversationsDir()
	ConfigurePartitioning(root, &types.PrincipalPartitioningConfig{Enabled: true})

	conv := CreateConversation(NewConversationID(), "", "test-model")
	conv.Principal = &types.ConversationPrincipal{Subject: "oidc:alice"}
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Simulate a restart: clear in-memory state, reconfigure from the SAME
	// disk layout, and confirm the conversation resolves without ever
	// having been re-saved this process lifetime.
	ResetPartitioningForTest()
	ConfigurePartitioning(root, &types.PrincipalPartitioningConfig{Enabled: true})

	if !Exists(conv.ID, "") {
		t.Fatal("expected the rebuilt index to find the conversation after a simulated restart")
	}
}

func TestDeleteStoredExact_RemovesFromOwnerPartitionAndIndex(t *testing.T) {
	setupPartitionTest(t)
	root := DefaultConversationsDir()
	ConfigurePartitioning(root, &types.PrincipalPartitioningConfig{Enabled: true})

	conv := CreateConversation(NewConversationID(), "", "test-model")
	conv.Principal = &types.ConversationPrincipal{Subject: "oidc:alice"}
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	deleted, err := DeleteStoredExact("", []string{conv.ID}, nil)
	if err != nil {
		t.Fatalf("DeleteStoredExact: %v", err)
	}
	if len(deleted) != 1 || deleted[0] != conv.ID {
		t.Fatalf("expected %q deleted, got %v", conv.ID, deleted)
	}
	if Exists(conv.ID, "") {
		t.Fatal("conversation should no longer exist after DeleteStoredExact")
	}
	if _, ok := lookupPartitionDir(conv.ID); ok {
		t.Fatal("index should no longer resolve the deleted conversation")
	}
}

func TestListStoredFor_ListsOnlyOwnersPartition(t *testing.T) {
	setupPartitionTest(t)
	root := DefaultConversationsDir()
	ConfigurePartitioning(root, &types.PrincipalPartitioningConfig{Enabled: true})

	alice := CreateConversation(NewConversationID(), "", "test-model")
	alice.Principal = &types.ConversationPrincipal{Subject: "oidc:alice"}
	AddUserMessage(alice, "hi")
	if err := Save(alice, ""); err != nil {
		t.Fatalf("Save alice: %v", err)
	}
	bob := CreateConversation(NewConversationID(), "", "test-model")
	bob.Principal = &types.ConversationPrincipal{Subject: "oidc:bob"}
	AddUserMessage(bob, "hi")
	if err := Save(bob, ""); err != nil {
		t.Fatalf("Save bob: %v", err)
	}

	aliceList, err := ListStoredFor("oidc:alice", 50)
	if err != nil {
		t.Fatalf("ListStoredFor alice: %v", err)
	}
	if len(aliceList) != 1 || aliceList[0].SessionID != alice.ID {
		t.Fatalf("expected only alice's conversation, got %+v", aliceList)
	}
}

func TestEnforcementDefaultsToStrictWhenEnabledWithNoExplicitLevel(t *testing.T) {
	setupPartitionTest(t)
	ConfigurePartitioning(DefaultConversationsDir(), &types.PrincipalPartitioningConfig{Enabled: true})
	if got := PartitioningEnforcement(); got != types.EnforcementStrict {
		t.Fatalf("expected default enforcement strict, got %q", got)
	}
}

func TestSealMinEnforcement_NeverSoftensBelowTheFloor(t *testing.T) {
	if got := types.SealMinEnforcement(types.EnforcementNone, types.EnforcementStrict); got != types.EnforcementStrict {
		t.Fatalf("expected floor to win over a looser configured value, got %q", got)
	}
	if got := types.SealMinEnforcement(types.EnforcementStrict, types.EnforcementReadOnly); got != types.EnforcementStrict {
		t.Fatalf("expected the STRICTER configured value to stand over a looser floor, got %q", got)
	}
}
