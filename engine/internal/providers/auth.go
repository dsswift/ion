package providers

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// setAuthHeader sets the authentication header on a request based on the
// configured auth style. Supports any provider's native default or custom
// gateway/proxy overrides.
//
// Known values:
//   - "bearer" -> Authorization: Bearer <key>
//   - "x-api-key" -> x-api-key: <key>
//   - "api-key" -> api-key: <key> (Azure style)
//   - any other string -> used as literal header name with key as value
//
// Enterprise deployments can set any header their gateway expects.
func setAuthHeader(req *http.Request, style string, apiKey string) {
	utils.LogWithFields(utils.LevelDebug, "Auth", "set auth header", map[string]any{"reason": style, "count": len(apiKey), "path": req.URL.Host})
	if apiKey == "" {
		utils.LogWithFields(utils.LevelWarn, "Auth", "set auth header called with empty api key", map[string]any{"path": req.URL.Host})
	}
	switch strings.ToLower(style) {
	case "bearer", "":
		req.Header.Set("Authorization", "Bearer "+apiKey)
	case "x-api-key":
		req.Header.Set("x-api-key", apiKey)
	case "api-key":
		req.Header.Set("api-key", apiKey)
	default:
		// Custom header name (enterprise gateway flexibility)
		req.Header.Set(style, apiKey)
	}
}

// keyRequiredHosts names the canonical hosted API endpoints where an API key
// is definitionally required: a request without one is a guaranteed 401.
// Deliberately narrow — ONLY the vendors' own hosts. Custom base URLs
// (enterprise gateways with ambient auth, local Ollama, proxies) may be
// legitimately keyless and are never gated.
var keyRequiredHosts = map[string]bool{
	"api.anthropic.com": true,
	"api.openai.com":    true,
}

// requireKeyForHost fails fast when a request targets a canonical hosted
// endpoint with an empty resolved API key. The engine already KNOWS such a
// request will 401 — it logged "no key for provider" during key resolution —
// so dispatching it burns a full turn (and the operator's time) to learn what
// was already known. Returns a typed auth ProviderError (non-retryable, the
// same classification the API's own 401 would produce) for the caller to
// return instead of sending the request; nil when a key is present or the
// host is not key-required. Both branches log so the decision is
// reconstructible from engine.jsonl.
func requireKeyForHost(host, providerID, apiKey string) *ProviderError {
	if apiKey != "" || !keyRequiredHosts[host] {
		utils.LogWithFields(utils.LevelDebug, "Auth", "key precheck passed", map[string]any{"path": host, "provider": providerID, "status": apiKey != ""})
		return nil
	}
	utils.LogWithFields(utils.LevelError, "Auth", "key precheck failed: no api key for key-required host, failing fast", map[string]any{"path": host, "provider": providerID})
	return NewProviderError(
		ErrAuth,
		fmt.Sprintf("no API key resolved for provider %q (host %s): the request would be rejected with 401. Configure a key via keychain, engine.json, or the provider's environment variable.", providerID, host),
		401,
		false,
	)
}
