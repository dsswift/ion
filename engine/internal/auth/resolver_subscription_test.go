package auth

import "testing"

func TestSubscriptionKeyOutranksManualKeyAndClearsBack(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	r := NewResolver(nil)
	r.SetProgrammatic("gateway", "manual-key")

	r.SetSubscriptionKey("Gateway", "looked-up-key")
	if key, err := r.ResolveKey("gateway"); err != nil || key != "looked-up-key" {
		t.Fatalf("resolve with subscription key = %q, %v", key, err)
	}
	if has, source := r.HasKey("gateway"); !has || source != SourceSubscription {
		t.Fatalf("has key = %v, %q", has, source)
	}

	r.ClearSubscriptionKey("gateway")
	if key, err := r.ResolveKey("gateway"); err != nil || key != "manual-key" {
		t.Fatalf("resolve after clear = %q, %v", key, err)
	}
}

func TestSubscriptionKeyInvalidatesCachedNegative(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	keychainLookup = func(string, string) (string, error) { return "", ErrKeyNotFound }
	t.Cleanup(func() { keychainLookup = GetKeychainPassword })
	r := NewResolver(nil)
	if has, _ := r.HasKey("unconfigured-gateway"); has {
		t.Fatal("unconfigured provider reported a key")
	}
	r.SetSubscriptionKey("unconfigured-gateway", "looked-up-key")
	if has, source := r.HasKey("unconfigured-gateway"); !has || source != SourceSubscription {
		t.Fatalf("has key after apply = %v, %q", has, source)
	}
}
