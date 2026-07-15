package providers

import (
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
