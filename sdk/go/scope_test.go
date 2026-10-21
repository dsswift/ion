package ion

import "testing"

func TestScopeFromEnvDefaultsToSession(t *testing.T) {
	t.Setenv(ScopeEnv, "")
	if ScopeFromEnv() != ScopeSession {
		t.Fatal("no env is a session host")
	}
	t.Setenv(ScopeEnv, "bogus")
	if ScopeFromEnv() != ScopeSession {
		t.Fatal("an unknown value is a session host")
	}
	t.Setenv(ScopeEnv, "engine")
	if ScopeFromEnv() != ScopeEngine {
		t.Fatal("engine")
	}
}

func TestSDKScopeKnownBeforeRun(t *testing.T) {
	t.Setenv(ScopeEnv, "engine")
	sdk := New(WithName("scoped"))
	if sdk.Scope() != ScopeEngine || !sdk.IsEngineScope() {
		t.Fatalf("scope = %q before Run, want engine", sdk.Scope())
	}
	t.Setenv(ScopeEnv, "")
	if New(WithName("plain")).Scope() != ScopeSession {
		t.Fatal("default scope is session")
	}
}
