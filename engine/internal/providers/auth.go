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
	utils.Log("Auth", fmt.Sprintf("setAuthHeader: style=%q keyLen=%d url=%s", style, len(apiKey), req.URL.Host))
	if apiKey == "" {
		utils.Log("Auth", fmt.Sprintf("WARNING: setAuthHeader called with empty API key for %s", req.URL.Host))
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
