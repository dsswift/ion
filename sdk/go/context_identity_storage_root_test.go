package ion

import (
	"encoding/json"
	"testing"
)

// TestNewContextDecodesIdentityStorageRoot pins the additive storageRoot
// field on ContextIdentity (Task 11): present when principal partitioning
// is enabled and the principal has a subject, absent otherwise.
func TestNewContextDecodesIdentityStorageRoot(t *testing.T) {
	sdk := New()
	sdk.cfg = ExtensionConfig{WorkingDirectory: "/from-init"}
	meta := json.RawMessage(`{
		"sessionKey":"session-1",
		"identity":{"kind":"operator","provider":"oidc","subject":"local:alice","storageRoot":"/data/partitions/local-alice"}
	}`)

	ctx := sdk.newContext(meta)
	if ctx.Identity == nil {
		t.Fatal("Identity = nil, want decoded identity")
	}
	if ctx.Identity.StorageRoot != "/data/partitions/local-alice" {
		t.Errorf("Identity.StorageRoot = %q, want /data/partitions/local-alice", ctx.Identity.StorageRoot)
	}
}

// TestNewContextIdentityStorageRootAbsentWhenPartitioningOff pins the
// absent-means-unchanged contract: an identity with no storageRoot key
// decodes to the empty string, not an error, and every other field on the
// identity still decodes.
func TestNewContextIdentityStorageRootAbsentWhenPartitioningOff(t *testing.T) {
	sdk := New()
	sdk.cfg = ExtensionConfig{WorkingDirectory: "/from-init"}
	meta := json.RawMessage(`{
		"sessionKey":"session-1",
		"identity":{"kind":"operator","provider":"oidc","subject":"local:alice"}
	}`)

	ctx := sdk.newContext(meta)
	if ctx.Identity == nil {
		t.Fatal("Identity = nil, want decoded identity")
	}
	if ctx.Identity.StorageRoot != "" {
		t.Errorf("Identity.StorageRoot = %q, want empty string when the engine omits the key", ctx.Identity.StorageRoot)
	}
	if ctx.Identity.Subject != "local:alice" {
		t.Errorf("Identity.Subject = %q, want local:alice (sibling field must still decode)", ctx.Identity.Subject)
	}
}
