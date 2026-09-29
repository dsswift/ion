package extension

import "testing"

// TestParseInitResult_HandshakeVersionWinsOverManifest verifies that a
// version reported in the init handshake takes priority over a version
// already stamped from extension.json at load time. This is the path a
// compiled extension (no extension.json) relies on exclusively, and the path
// a TS extension uses when its handshake and manifest happen to agree.
func TestParseInitResult_HandshakeVersionWinsOverManifest(t *testing.T) {
	h := &Host{sdk: NewSDK(), version: "0.1.0-manifest"}
	h.setName("test-ext")

	if err := h.parseInitResult([]byte(`{"version":"2.3.4"}`)); err != nil {
		t.Fatalf("parseInitResult: %v", err)
	}
	if h.Version() != "2.3.4" {
		t.Errorf("Version() = %q, want %q (handshake should win)", h.Version(), "2.3.4")
	}
}

// TestParseInitResult_NoHandshakeVersionFallsBackToManifest verifies that an
// older SDK omitting the version field leaves the manifest-derived version
// untouched (additive-field backward compat).
func TestParseInitResult_NoHandshakeVersionFallsBackToManifest(t *testing.T) {
	h := &Host{sdk: NewSDK(), version: "0.1.0-manifest"}
	h.setName("test-ext")

	if err := h.parseInitResult([]byte(`{"tools":[]}`)); err != nil {
		t.Fatalf("parseInitResult: %v", err)
	}
	if h.Version() != "0.1.0-manifest" {
		t.Errorf("Version() = %q, want manifest value %q preserved", h.Version(), "0.1.0-manifest")
	}
}

// TestParseInitResult_NoVersionAnywhereStaysEmpty verifies that a compiled
// extension with neither a manifest nor a handshake version (the pre-fix
// cos2 case) leaves Version() empty rather than fabricating one.
func TestParseInitResult_NoVersionAnywhereStaysEmpty(t *testing.T) {
	h := &Host{sdk: NewSDK()}
	h.setName("test-ext")

	if err := h.parseInitResult([]byte(`{}`)); err != nil {
		t.Fatalf("parseInitResult: %v", err)
	}
	if h.Version() != "" {
		t.Errorf("Version() = %q, want empty when neither source reports one", h.Version())
	}
}
