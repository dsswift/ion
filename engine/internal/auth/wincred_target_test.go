package auth

import "testing"

// The target name is the whole address of a credential in Windows Credential
// Manager: get it wrong and every lookup misses, silently, and the resolver
// falls through to the next source as though the operator had stored nothing.
func TestCredentialTargetName(t *testing.T) {
	if got, want := credentialTargetName("ion-engine", "anthropic"), "ion-engine:anthropic"; got != want {
		t.Errorf("credentialTargetName = %q, want %q", got, want)
	}
	if a, b := credentialTargetName("ion-engine", "openai"), credentialTargetName("ion-engine", "anthropic"); a == b {
		t.Error("two providers produced the same target name; one would overwrite the other")
	}
}

// Windows records no encoding for a credential blob, so the write and the
// read have to agree by construction. A round trip is what pins that.
func TestCredentialBlobRoundTrip(t *testing.T) {
	for _, secret := range []string{
		"sk-ant-api03-abcdef",
		"",
		"key with spaces and 'quotes' and \"doubles\"",
		"unicode: éü中文 \U0001F511",
	} {
		blob := encodeCredentialBlob(secret)
		if len(blob)%2 != 0 {
			t.Fatalf("encoded %q to an odd-length blob", secret)
		}
		got, err := decodeCredentialBlob(blob)
		if err != nil {
			t.Fatalf("decode %q: %v", secret, err)
		}
		if got != secret {
			t.Errorf("round trip of %q produced %q", secret, got)
		}
	}
}

// UTF-16LE is what cmdkey, the Credential Manager UI, and the PasswordVault
// API all write, so a key an operator stored by hand has to decode to the
// same string the engine would have written.
func TestDecodeCredentialBlob_MatchesWindowsToolingEncoding(t *testing.T) {
	// "abc" as UTF-16LE, the exact bytes Windows tooling stores.
	got, err := decodeCredentialBlob([]byte{0x61, 0x00, 0x62, 0x00, 0x63, 0x00})
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got != "abc" {
		t.Errorf("decoded %q, want \"abc\"", got)
	}
}

// A blob that is not UTF-16 must be reported, never truncated into a
// different-but-plausible key: a wrong key reaches the provider as an auth
// failure the operator cannot explain.
func TestDecodeCredentialBlob_RejectsOddLength(t *testing.T) {
	if _, err := decodeCredentialBlob([]byte{0x61, 0x00, 0x62}); err == nil {
		t.Error("decodeCredentialBlob accepted an odd-length blob")
	}
}
