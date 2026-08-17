package extension

import "testing"

func TestObserveBuildIdentity_AllowsMismatch(t *testing.T) {
	h := &Host{engineBuildIdentity: "v1.2.3-engine"}
	h.setName("independent-extension")
	h.observeBuildIdentity("v1.0.0-sdk")
}

func TestParseInitResult_BuildIdentityMismatchLoadsTools(t *testing.T) {
	h := &Host{engineBuildIdentity: "v2.0.0"}
	h.setName("test-ext")
	h.sdk = NewSDK()

	raw := []byte(`{"buildIdentity":"v1.0.0","tools":[{"name":"older_sdk_tool","description":"d"}]}`)
	if err := h.parseInitResult(raw); err != nil {
		t.Fatalf("independently deployed extension rejected: %v", err)
	}
	if !hasTool(h.sdk, "older_sdk_tool") {
		t.Fatal("tool from different SDK build was not registered")
	}
}

func TestParseInitResult_NewerSDKIdentityLoadsTools(t *testing.T) {
	h := &Host{engineBuildIdentity: "v1.0.0"}
	h.setName("test-ext")
	h.sdk = NewSDK()

	raw := []byte(`{"buildIdentity":"v3.0.0","tools":[{"name":"newer_sdk_tool","description":"d"}]}`)
	if err := h.parseInitResult(raw); err != nil {
		t.Fatalf("newer SDK extension rejected before capability use: %v", err)
	}
	if !hasTool(h.sdk, "newer_sdk_tool") {
		t.Fatal("tool from newer SDK build was not registered")
	}
}
