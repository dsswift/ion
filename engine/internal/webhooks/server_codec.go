// Request/response codec helpers for the webhook server. Handles
// assembling the wire payload sent to the SDK runtime and decoding
// the handler's structured response.
//
// Extracted from server.go to keep the main dispatch pipeline focused
// on routing and handler invocation.

package webhooks

import (
	"encoding/json"
	"net/http"

	"github.com/dsswift/ion/engine/internal/extension"
)

// buildRequestPayload assembles the wire payload sent to the SDK
// runtime for a single fire. The SDK runtime exposes lazy `req.json()`
// / `req.text()` accessors over the rawBody bytes.
func buildRequestPayload(r *http.Request, route extension.WebhookRoute, body []byte) map[string]interface{} {
	headers := make(map[string]string, len(r.Header))
	for k, v := range r.Header {
		if len(v) > 0 {
			// Single-valued headers are the common case; for multi-valued
			// headers we send the first value and document it.
			headers[k] = v[0]
		}
	}
	return map[string]interface{}{
		"method":  r.Method,
		"path":    route.Path,
		"url":     r.URL.String(),
		"query":   r.URL.RawQuery,
		"headers": headers,
		"body":    string(body),
		"bodyB64": false,
		"remote":  r.RemoteAddr,
	}
}

// decodeHandlerResponse extracts {status, body, headers} from the
// subprocess's reply. Tolerant of missing or null fields — a bare null
// reply (handler returned undefined) becomes 200 / "" / no headers.
func decodeHandlerResponse(raw json.RawMessage) (int, string, map[string]string) {
	if len(raw) == 0 || string(raw) == "null" {
		return http.StatusOK, "", nil
	}
	var parsed struct {
		Status  int               `json:"status"`
		Body    string            `json:"body"`
		Headers map[string]string `json:"headers"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		// Not a structured response — treat the whole payload as the
		// body and return 200.
		return http.StatusOK, string(raw), nil
	}
	if parsed.Status == 0 {
		parsed.Status = http.StatusOK
	}
	return parsed.Status, parsed.Body, parsed.Headers
}
