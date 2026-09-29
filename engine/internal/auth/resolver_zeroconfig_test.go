package auth

import "testing"

// R-33: an install with no config, no principal, and no server resolves a
// credential from each of environment, keychain, and file store on its own.
// R-28: the resolution order for an unattributed principal is unchanged from
// the baseline (auth.Resolver's five levels, consulted in the same order).

func TestZeroConfig_EnvVarResolves(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ANTHROPIC_API_KEY", "sk-zero-config-env")

	r := NewResolver(nil)
	key, err := r.ResolveKey("anthropic")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "sk-zero-config-env" {
		t.Fatalf("expected env-resolved key, got %q", key)
	}
}

func TestZeroConfig_KeychainResolves(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ANTHROPIC_API_KEY", "")

	original := keychainLookup
	defer func() { keychainLookup = original }()
	keychainLookup = func(service, account string) (string, error) {
		if account == "anthropic" {
			return "sk-zero-config-keychain", nil
		}
		return "", nil
	}

	r := NewResolver(nil)
	key, err := r.ResolveKey("anthropic")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "sk-zero-config-keychain" {
		t.Fatalf("expected keychain-resolved key, got %q", key)
	}
}

func TestZeroConfig_FileStoreResolves(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("ANTHROPIC_API_KEY", "")

	fs := NewFileStore()
	if err := fs.SetKey("anthropic", "sk-zero-config-filestore"); err != nil {
		t.Fatalf("seed filestore: %v", err)
	}

	r := NewResolver(nil)
	key, err := r.ResolveKey("anthropic")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "sk-zero-config-filestore" {
		t.Fatalf("expected filestore-resolved key, got %q", key)
	}
}

// TestUnattributedResolutionOrderUnchanged pins that with nothing but an env
// var and a filestore entry both present, the resolver still returns the env
// value -- level 2 before level 4a, exactly as baseline.md documents.
func TestUnattributedResolutionOrderUnchanged(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("ANTHROPIC_API_KEY", "sk-env-wins")

	fs := NewFileStore()
	if err := fs.SetKey("anthropic", "sk-filestore-loses"); err != nil {
		t.Fatalf("seed filestore: %v", err)
	}

	r := NewResolver(nil)
	key, err := r.ResolveKey("anthropic")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "sk-env-wins" {
		t.Fatalf("expected env var to outrank filestore, got %q", key)
	}

	has, source := r.HasKey("anthropic")
	if !has || source != "env" {
		t.Fatalf("expected HasKey to report env as the source, got has=%v source=%q", has, source)
	}
}

// TestHasKey_Bedrock_FullyConfigured pins R-24/child-01-phase-2: HasKey must
// report true for a fully configured multi-value provider, not just a
// single-key one, so routing (child 06) never treats a configured Bedrock as
// keyless.
func TestHasKey_Bedrock_FullyConfigured(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIATEST")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	t.Setenv("AWS_SESSION_TOKEN", "")
	t.Setenv("AWS_REGION", "")
	t.Setenv("AWS_DEFAULT_REGION", "")
	InvalidateAllHasKey()

	r := NewResolver(nil)
	has, source := r.HasKey("bedrock")
	if !has {
		t.Fatal("expected HasKey to report true for a fully configured bedrock")
	}
	if source != "env" {
		t.Errorf("expected source 'env', got %q", source)
	}
}

func TestHasKey_Bedrock_PartiallyConfigured(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIATEST")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	t.Setenv("AWS_SESSION_TOKEN", "")
	t.Setenv("AWS_REGION", "")
	t.Setenv("AWS_DEFAULT_REGION", "")
	InvalidateAllHasKey()

	r := NewResolver(nil)
	has, _ := r.HasKey("bedrock")
	if has {
		t.Fatal("expected HasKey to report false for a partially configured bedrock (matches constructor behavior)")
	}
}
