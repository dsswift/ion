package auth

import (
	"testing"
)

func TestHasKey(t *testing.T) {
	r := NewResolver(nil)

	// No keys set: should return false
	has, source := r.HasKey("testprovider")
	if has {
		t.Errorf("expected HasKey to return false for unconfigured provider, got source=%s", source)
	}

	// Set programmatic key
	r.SetProgrammatic("testprovider", "test-key-123")
	has, source = r.HasKey("testprovider")
	if !has {
		t.Error("expected HasKey to return true after SetProgrammatic")
	}
	if source != "programmatic" {
		t.Errorf("expected source 'programmatic', got %q", source)
	}

	// Case insensitive
	has, _ = r.HasKey("TestProvider")
	if !has {
		t.Error("expected HasKey to be case-insensitive")
	}

	// Empty key should not count
	r.SetProgrammatic("emptyprovider", "")
	has, _ = r.HasKey("emptyprovider")
	if has {
		t.Error("expected HasKey to return false for empty programmatic key")
	}
}

func TestHasKeyEnv(t *testing.T) {
	r := NewResolver(nil)

	// Set env var temporarily
	t.Setenv("GROQ_API_KEY", "test-groq-key")

	has, source := r.HasKey("groq")
	if !has {
		t.Error("expected HasKey to return true when env var is set")
	}
	if source != "env" {
		t.Errorf("expected source 'env', got %q", source)
	}
}

func TestResolveKeyProgrammatic(t *testing.T) {
	r := NewResolver(nil)
	r.SetProgrammatic("testprovider", "prog-key-456")

	key, err := r.ResolveKey("testprovider")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "prog-key-456" {
		t.Errorf("expected 'prog-key-456', got %q", key)
	}
}

func TestResolveKeyEnv(t *testing.T) {
	r := NewResolver(nil)
	t.Setenv("OPENAI_API_KEY", "env-openai-key")

	key, err := r.ResolveKey("openai")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "env-openai-key" {
		t.Errorf("expected 'env-openai-key', got %q", key)
	}
}

func TestResolveKeyProgrammaticOverridesEnv(t *testing.T) {
	r := NewResolver(nil)
	t.Setenv("OPENAI_API_KEY", "env-key")
	r.SetProgrammatic("openai", "prog-key")

	key, err := r.ResolveKey("openai")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "prog-key" {
		t.Errorf("expected programmatic key to take priority, got %q", key)
	}
}

func TestResolveKeyNotFound(t *testing.T) {
	r := NewResolver(nil)

	_, err := r.ResolveKey("nonexistentprovider")
	if err == nil {
		t.Error("expected error for unresolvable provider")
	}
}

func TestResolveKeyGenericEnvPattern(t *testing.T) {
	r := NewResolver(nil)
	// The resolver falls back to <UPPER(provider)>_API_KEY for unknown providers
	t.Setenv("CUSTOMPROVIDER_API_KEY", "custom-key")

	key, err := r.ResolveKey("customprovider")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "custom-key" {
		t.Errorf("expected 'custom-key', got %q", key)
	}
}

func TestHasKeyGenericEnvPattern(t *testing.T) {
	r := NewResolver(nil)
	t.Setenv("MYPROVIDER_API_KEY", "my-key")

	has, source := r.HasKey("myprovider")
	if !has {
		t.Error("expected HasKey to return true for generic env pattern")
	}
	if source != "env" {
		t.Errorf("expected source 'env', got %q", source)
	}
}

func TestSetProgrammaticOverwrite(t *testing.T) {
	r := NewResolver(nil)
	r.SetProgrammatic("provider", "key1")
	r.SetProgrammatic("provider", "key2")

	key, err := r.ResolveKey("provider")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "key2" {
		t.Errorf("expected overwritten key 'key2', got %q", key)
	}
}
