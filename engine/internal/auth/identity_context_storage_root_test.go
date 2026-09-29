package auth

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestFromSessionPrincipalStorageRoot(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())

	t.Run("empty when partitioning is disabled", func(t *testing.T) {
		conversation.ResetPartitioningForTest()
		identity := FromSessionPrincipal(&types.SessionPrincipal{Subject: "local:alice", Provider: "test", Kind: "operator"})
		if identity.StorageRoot != "" {
			t.Fatalf("expected empty StorageRoot with partitioning disabled, got %q", identity.StorageRoot)
		}
	})

	t.Run("resolves under the partition when partitioning is enabled", func(t *testing.T) {
		conversation.ConfigurePartitioning(conversation.DefaultConversationsDir(), &types.PrincipalPartitioningConfig{Enabled: true})
		defer conversation.ResetPartitioningForTest()

		identity := FromSessionPrincipal(&types.SessionPrincipal{Subject: "local:alice", Provider: "test", Kind: "operator"})
		want := conversation.PartitionConversationsDir("local:alice")
		if identity.StorageRoot != want {
			t.Fatalf("StorageRoot = %q, want %q", identity.StorageRoot, want)
		}
	})

	t.Run("empty when the principal has no subject, even with partitioning enabled", func(t *testing.T) {
		conversation.ConfigurePartitioning(conversation.DefaultConversationsDir(), &types.PrincipalPartitioningConfig{Enabled: true})
		defer conversation.ResetPartitioningForTest()

		identity := FromSessionPrincipal(&types.SessionPrincipal{Provider: "test", Kind: "operator"})
		if identity.StorageRoot != "" {
			t.Fatalf("expected empty StorageRoot for a subject-less principal, got %q", identity.StorageRoot)
		}
	})

	t.Run("nil principal returns nil identity, not a panic", func(t *testing.T) {
		conversation.ConfigurePartitioning(conversation.DefaultConversationsDir(), &types.PrincipalPartitioningConfig{Enabled: true})
		defer conversation.ResetPartitioningForTest()

		if identity := FromSessionPrincipal(nil); identity != nil {
			t.Fatalf("expected nil identity for a nil principal, got %+v", identity)
		}
	})
}
