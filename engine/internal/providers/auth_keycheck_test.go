package providers

import (
	"strings"
	"testing"
)

// Tests for the fail-fast key precheck (requireKeyForHost): a request to a
// canonical hosted endpoint with an empty resolved API key is a guaranteed
// 401, and the engine must not burn a turn dispatching it (the
// 1785287375912-83a63c0a7af1 incident: "no key for provider" was logged and
// the request was sent anyway).
//
// Revert bar: removing the requireKeyForHost calls from the anthropic/openai
// doStream paths does not turn THESE unit tests red (they pin the helper),
// but TestRequireKey_EmptyKeyOnCanonicalHostFails failing means the helper
// itself regressed — and the helper is the single choke point both call
// sites share.

func TestRequireKey_EmptyKeyOnCanonicalHostFails(t *testing.T) {
	for _, host := range []string{"api.anthropic.com", "api.openai.com"} {
		pe := requireKeyForHost(host, "some-provider", "")
		if pe == nil {
			t.Fatalf("host %s: empty key must fail fast, got nil", host)
		}
		if pe.Code != ErrAuth {
			t.Errorf("host %s: code = %q, want %q (same classification as the API's own 401)", host, pe.Code, ErrAuth)
		}
		if pe.Retryable {
			t.Errorf("host %s: a missing key is not retryable", host)
		}
		if pe.HTTPStatus != 401 {
			t.Errorf("host %s: status = %d, want 401", host, pe.HTTPStatus)
		}
		if !strings.Contains(pe.Message, "no API key resolved") {
			t.Errorf("host %s: message %q does not explain the missing key", host, pe.Message)
		}
	}
}

func TestRequireKey_KeyPresentPasses(t *testing.T) {
	if pe := requireKeyForHost("api.anthropic.com", "anthropic", "sk-ant-xxx"); pe != nil {
		t.Fatalf("a present key must pass the precheck, got %v", pe)
	}
}

// Custom base URLs (enterprise gateways with ambient auth, local Ollama,
// proxies) may be legitimately keyless: the precheck gates ONLY the
// canonical vendor hosts.
func TestRequireKey_CustomHostsNeverGated(t *testing.T) {
	for _, host := range []string{"localhost:11434", "gateway.corp.example", "ai.dcim.com"} {
		if pe := requireKeyForHost(host, "custom", ""); pe != nil {
			t.Errorf("host %s: custom hosts must never be gated on a missing key, got %v", host, pe)
		}
	}
}
