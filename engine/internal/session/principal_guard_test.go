package session

import (
	"errors"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func setupPrincipalGuardTest(t *testing.T) {
	t.Helper()
	t.Setenv("ION_DATA_DIR", t.TempDir())
	conversation.ConfigurePartitioning(conversation.DefaultConversationsDir(), &types.PrincipalPartitioningConfig{Enabled: true})
	t.Cleanup(conversation.ResetPartitioningForTest)
}

func principalFor(subject string) *types.SessionPrincipal {
	return &types.SessionPrincipal{Subject: subject, Provider: "test", Kind: "operator"}
}

// savedConversationOwnedBy creates and PERSISTS a conversation attributed to
// subject, bypassing the session/backend run loop entirely (StartSession
// alone never mints or saves a conversation -- that happens at first-prompt
// mint in backend/runloop_setup.go). This is the direct fixture every
// checkConversationAccess test needs: an existing, owned, on-disk conversation.
func savedConversationOwnedBy(t *testing.T, subject string) string {
	t.Helper()
	id := conversation.NewConversationID()
	conv := conversation.CreateConversation(id, "", "test-model")
	conv.Principal = &types.ConversationPrincipal{Subject: subject}
	conversation.AddUserMessage(conv, "hi")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save fixture conversation: %v", err)
	}
	return id
}

func TestCheckConversationAccess_DisabledPartitioningAlwaysAllows(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	conversation.ResetPartitioningForTest() // explicit: partitioning disabled
	if err := checkConversationAccess(principalFor("oidc:alice"), "some-id", true); err != nil {
		t.Fatalf("expected no error with partitioning disabled, got %v", err)
	}
}

func TestCheckConversationAccess_NoBackingFileIsAlwaysAllowed(t *testing.T) {
	setupPrincipalGuardTest(t)
	if err := checkConversationAccess(principalFor("oidc:alice"), "never-created", true); err != nil {
		t.Fatalf("a not-yet-created conversation has nothing to own; expected nil, got %v", err)
	}
}

func TestCheckConversationAccess_OwnerCanAlwaysAccessTheirOwn(t *testing.T) {
	setupPrincipalGuardTest(t)
	alice := principalFor("oidc:alice")
	convID := savedConversationOwnedBy(t, "oidc:alice")

	if err := checkConversationAccess(alice, convID, true); err != nil {
		t.Fatalf("owner should always have access, got %v", err)
	}
}

func TestCheckConversationAccess_StrictRefusesCrossPrincipalReadAndWrite(t *testing.T) {
	setupPrincipalGuardTest(t)
	convID := savedConversationOwnedBy(t, "oidc:alice")
	bob := principalFor("oidc:bob")

	if err := checkConversationAccess(bob, convID, false); !errors.Is(err, ErrConversationNotOwned) {
		t.Errorf("expected ErrConversationNotOwned on cross-principal read under strict, got %v", err)
	}
	if err := checkConversationAccess(bob, convID, true); !errors.Is(err, ErrConversationNotOwned) {
		t.Errorf("expected ErrConversationNotOwned on cross-principal write under strict, got %v", err)
	}
}

func TestCheckConversationAccess_ReadOnlyAllowsCrossPrincipalReadButNotWrite(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	conversation.ConfigurePartitioning(conversation.DefaultConversationsDir(), &types.PrincipalPartitioningConfig{Enabled: true, Enforcement: types.EnforcementReadOnly})
	t.Cleanup(conversation.ResetPartitioningForTest)

	convID := savedConversationOwnedBy(t, "oidc:alice")
	bob := principalFor("oidc:bob")

	if err := checkConversationAccess(bob, convID, false); err != nil {
		t.Errorf("expected read-only enforcement to allow a cross-principal READ, got %v", err)
	}
	if err := checkConversationAccess(bob, convID, true); !errors.Is(err, ErrConversationNotOwned) {
		t.Errorf("expected read-only enforcement to still refuse a cross-principal WRITE, got %v", err)
	}
}

func TestCheckConversationAccess_UnattributedCallerCannotAccessAnOwnedConversation(t *testing.T) {
	setupPrincipalGuardTest(t)
	convID := savedConversationOwnedBy(t, "oidc:alice")

	if err := checkConversationAccess(nil, convID, false); !errors.Is(err, ErrConversationNotOwned) {
		t.Errorf("expected an unattributed caller refused access to an owned conversation, got %v", err)
	}
}

// TestStartSession_FreshKeyRefusedAcrossPrincipals pins the SECOND guard
// site in start_session.go: a brand-new session key whose resolved
// conversation id (an explicit SessionID) belongs to a different principal.
func TestStartSession_FreshKeyRefusedAcrossPrincipals(t *testing.T) {
	setupPrincipalGuardTest(t)
	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()

	aliceConvID := savedConversationOwnedBy(t, "oidc:alice")
	bob := principalFor("oidc:bob")

	_, err := mgr.StartSession("bob-tab", types.EngineConfig{WorkingDirectory: testWorkDir(), SessionID: aliceConvID}, bob)
	if !errors.Is(err, ErrConversationNotOwned) {
		t.Fatalf("expected a fresh session key naming alice's conversation refused for bob, got %v", err)
	}
}

// TestStartSession_FreshKeyAllowedForTheOwner is the same wiring path's
// positive case: the owner naming their own conversation on a fresh key
// must succeed unchanged.
func TestStartSession_FreshKeyAllowedForTheOwner(t *testing.T) {
	setupPrincipalGuardTest(t)
	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()

	aliceConvID := savedConversationOwnedBy(t, "oidc:alice")
	alice := principalFor("oidc:alice")

	res, err := mgr.StartSession("alice-tab", types.EngineConfig{WorkingDirectory: testWorkDir(), SessionID: aliceConvID}, alice)
	if err != nil {
		t.Fatalf("expected alice to resume her own conversation, got %v", err)
	}
	if res.ConversationID != aliceConvID {
		t.Fatalf("expected resumed conversation id %q, got %q", aliceConvID, res.ConversationID)
	}
}

func TestStartSession_StorageRootEmptyWhenPartitioningDisabled(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	conversation.ResetPartitioningForTest()
	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()

	res, err := mgr.StartSession("tab-1", types.EngineConfig{WorkingDirectory: testWorkDir()}, principalFor("oidc:alice"))
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if res.StorageRoot != "" {
		t.Errorf("expected empty StorageRoot with partitioning disabled, got %q", res.StorageRoot)
	}
}

func TestStartSession_StorageRootPopulatedForAnAttributedSession(t *testing.T) {
	setupPrincipalGuardTest(t)
	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()

	res, err := mgr.StartSession("tab-1", types.EngineConfig{WorkingDirectory: testWorkDir()}, principalFor("oidc:alice"))
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	want := conversation.PartitionConversationsDir("oidc:alice")
	if res.StorageRoot != want {
		t.Errorf("StorageRoot = %q, want %q", res.StorageRoot, want)
	}
}

// TestStartSession_RebindRefusedAcrossPrincipals pins the FIRST guard site:
// an existing session key re-asserting start_session with an explicit
// SessionID naming a DIFFERENT (and different-principal) conversation --
// the rebind branch.
func TestStartSession_RebindRefusedAcrossPrincipals(t *testing.T) {
	setupPrincipalGuardTest(t)
	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()

	bob := principalFor("oidc:bob")
	if _, err := mgr.StartSession("bob-tab", types.EngineConfig{WorkingDirectory: testWorkDir()}, bob); err != nil {
		t.Fatalf("bob StartSession: %v", err)
	}

	aliceConvID := savedConversationOwnedBy(t, "oidc:alice")

	// bob's EXISTING session key re-asserts start_session naming alice's
	// conversation id -- the rebind path (wantsRebind).
	_, err := mgr.StartSession("bob-tab", types.EngineConfig{WorkingDirectory: testWorkDir(), SessionID: aliceConvID}, bob)
	if !errors.Is(err, ErrConversationNotOwned) {
		t.Fatalf("expected rebind to alice's conversation refused for bob, got %v", err)
	}
}
