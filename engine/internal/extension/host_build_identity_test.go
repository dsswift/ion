package extension

import (
	"testing"
)

func TestValidateBuildIdentity_Match(t *testing.T) {
	h := &Host{engineBuildIdentity: "v1.2.3-abc1234"}
	h.name = "test-ext"
	if err := h.validateBuildIdentity("v1.2.3-abc1234"); err != nil {
		t.Fatalf("expected no error on match, got: %v", err)
	}
}

func TestValidateBuildIdentity_Mismatch(t *testing.T) {
	h := &Host{engineBuildIdentity: "v1.2.3-abc1234"}
	h.name = "test-ext"
	err := h.validateBuildIdentity("v1.0.0-old0000")
	if err == nil {
		t.Fatal("expected error on mismatch, got nil")
	}
	if got := err.Error(); got != `build identity mismatch: engine="v1.2.3-abc1234" sdk="v1.0.0-old0000"` {
		t.Errorf("unexpected error: %s", got)
	}
}

func TestValidateBuildIdentity_SDKEmpty_BackwardCompat(t *testing.T) {
	h := &Host{engineBuildIdentity: "v1.2.3-abc1234"}
	h.name = "test-ext"
	if err := h.validateBuildIdentity(""); err != nil {
		t.Fatalf("expected no error for old SDK (empty identity), got: %v", err)
	}
}

func TestValidateBuildIdentity_DevEngine_BackwardCompat(t *testing.T) {
	for _, engineIdentity := range []string{"", "dev"} {
		t.Run(engineIdentity, func(t *testing.T) {
			h := &Host{engineBuildIdentity: engineIdentity}
			h.name = "test-ext"
			if err := h.validateBuildIdentity("v1.0.0-some"); err != nil {
				t.Fatalf("expected no error for development engine identity %q, got: %v", engineIdentity, err)
			}
		})
	}
}

func TestValidateBuildIdentity_BothEmpty(t *testing.T) {
	h := &Host{engineBuildIdentity: ""}
	h.name = "test-ext"
	if err := h.validateBuildIdentity(""); err != nil {
		t.Fatalf("expected no error when both empty, got: %v", err)
	}
}

func TestParseInitResult_BuildIdentityMismatch_ReturnsError(t *testing.T) {
	h := &Host{engineBuildIdentity: "v2.0.0"}
	h.name = "test-ext"
	h.sdk = NewSDK()

	raw := []byte(`{"buildIdentity":"v1.0.0"}`)
	err := h.parseInitResult(raw)
	if err == nil {
		t.Fatal("expected parseInitResult to return error on mismatch, got nil")
	}
}

func hasTool(sdk *SDK, name string) bool {
	for _, t := range sdk.tools {
		if t.Name == name {
			return true
		}
	}
	return false
}

func TestParseInitResult_BuildIdentityMatch_Succeeds(t *testing.T) {
	h := &Host{engineBuildIdentity: "v2.0.0"}
	h.name = "test-ext"
	h.sdk = NewSDK()

	raw := []byte(`{"buildIdentity":"v2.0.0","tools":[{"name":"test","description":"d"}]}`)
	err := h.parseInitResult(raw)
	if err != nil {
		t.Fatalf("expected no error on match, got: %v", err)
	}
	if !hasTool(h.sdk, "test") {
		t.Error("tool 'test' was not registered after identity match")
	}
}

func TestParseInitResult_NoBuildIdentity_BackwardCompat(t *testing.T) {
	h := &Host{engineBuildIdentity: "v2.0.0"}
	h.name = "test-ext"
	h.sdk = NewSDK()

	raw := []byte(`{"tools":[{"name":"old","description":"from old sdk"}]}`)
	err := h.parseInitResult(raw)
	if err != nil {
		t.Fatalf("expected no error for old SDK without identity, got: %v", err)
	}
	if !hasTool(h.sdk, "old") {
		t.Error("tool 'old' was not registered for backward compat")
	}
}

func TestParseInitResult_MalformedPayload_ReturnsError(t *testing.T) {
	h := &Host{engineBuildIdentity: "v2.0.0"}
	h.name = "test-ext"
	h.sdk = NewSDK()

	err := h.parseInitResult([]byte(`{"tools":`))
	if err == nil {
		t.Fatal("expected malformed init result to return an error, got nil")
	}
	if hasTool(h.sdk, "test") {
		t.Error("malformed init result must not register tools")
	}
}
