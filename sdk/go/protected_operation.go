// protected_operation.go — config-declared operations with an engine-injected
// secret.
//
// The operator declares each operation under protectedOperations in the
// engine's global or enterprise config: method, destination, secret reference,
// injection slot, and payload schema. The extension names the operation and
// supplies a payload, nothing else. The engine injects the secret and strips
// every encoding of it from the result, so the credential never enters the
// extension process and the call cannot be redirected elsewhere.
package ion

import (
	"context"
	"encoding/json"
	"fmt"
)

// ProtectedOperationResult is a completed protected operation. The injected
// secret is replaced with "[redacted]" wherever the response reflected it.
type ProtectedOperationResult struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body"`
}

// JSON decodes the response body into v.
func (r ProtectedOperationResult) JSON(v any) error {
	if r.Body == "" {
		return fmt.Errorf("ion: cannot decode an empty response body (status %d)", r.Status)
	}
	return json.Unmarshal([]byte(r.Body), v)
}

// ProtectedOperation runs the declared operation name. The engine validates
// payload against the operation's schema, fills any {name} placeholders in
// the declared path from its top-level fields, and sends it as the JSON body
// (never for GET or HEAD). A nil payload sends no body. An unknown name, a
// rejected payload, an unavailable secret, or an engine with no declared
// operations is an error.
func (c *Context) ProtectedOperation(ctx context.Context, name string, payload any) (ProtectedOperationResult, error) {
	if name == "" {
		return ProtectedOperationResult{}, fmt.Errorf("ion: protected operation requires a name")
	}
	params := map[string]any{"name": name}
	if payload != nil {
		params["payload"] = payload
	}

	var out ProtectedOperationResult
	if err := c.sdk.call(ctx, "ext/protected_operation", params, &out); err != nil {
		c.sdk.logger.Error("protected operation failed", map[string]any{"operation": name, "error": err.Error()})
		return ProtectedOperationResult{}, err
	}
	c.sdk.logger.Debug("protected operation completed", map[string]any{
		"operation": name, "status": out.Status, "bytes": len(out.Body),
	})
	return out, nil
}
