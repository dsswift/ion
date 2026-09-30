// protected_operation.go — config-declared outbound operations with an
// engine-injected secret.
//
// DoProtectedOperation is the single implementation behind both SDK surfaces:
// the Go Context.ProtectedOperation field and the ext/protected_operation
// JSON-RPC method (the TypeScript SDK's ctx.protectedOperation).
//
// The extension names an operation and supplies a payload. Everything that
// decides where the secret goes (method, destination, injection slot, secret
// reference) comes from the operator's global engine.json. The engine
// resolves the secret from its credential store, injects it, performs the
// call without following redirects, and strips every encoding of the secret
// from the result and from any error before either leaves this function.
package extension

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// protectedOperationRedaction replaces every occurrence of the secret in a
// result or error.
const protectedOperationRedaction = "[redacted]"

// ErrProtectedOperationsUnavailable reports that no protected operation is
// declared, so the surface does not exist on this engine.
var ErrProtectedOperationsUnavailable = errors.New("protected operations are not configured")

// protectedOperationsSource is the indirection tests substitute to declare
// operations without writing the operator's engine.json.
var protectedOperationsSource = config.ResolveProtectedOperations

// protectedSecretSource resolves a secret reference for the acting subject.
// An attributed subject reads only its own credential-store partition.
var protectedSecretSource = func(subject, ref string) (string, error) {
	return auth.NewFileStore().GetKeyFor(subject, ref)
}

// ProtectedOperationParams is an extension's invocation: a name and a payload,
// nothing that could steer the request.
type ProtectedOperationParams struct {
	// Name selects a declared operation.
	Name string `json:"name"`
	// Payload is the JSON request body, validated against the operation's
	// bodySchema. Absent or null sends no body.
	Payload json.RawMessage `json:"payload,omitempty"`
}

// ProtectedOperationResult is what the extension receives. Every encoding of
// the injected secret is replaced with "[redacted]".
type ProtectedOperationResult struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body"`
}

// DoProtectedOperation runs one declared operation. The acting principal rides
// on ctx (auth.WithSubject) and selects the credential-store partition.
func DoProtectedOperation(ctx context.Context, params ProtectedOperationParams) (*ProtectedOperationResult, error) {
	subject := auth.SubjectFromContext(ctx)
	ops := protectedOperationsSource()
	if len(ops) == 0 {
		utils.LogWithFields(utils.LevelInfo, "extension.protected_operation", "protected operation refused: none configured", map[string]any{
			"operation": params.Name, "subject": subject,
		})
		return nil, ErrProtectedOperationsUnavailable
	}
	op, ok := ops[params.Name]
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "extension.protected_operation", "protected operation refused: unknown name", map[string]any{
			"operation": params.Name, "subject": subject,
		})
		return nil, fmt.Errorf("unknown protected operation %q", params.Name)
	}
	target, err := validateProtectedOperation(op)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "extension.protected_operation", "protected operation refused: invalid declaration", map[string]any{
			"operation": params.Name, "error": err.Error(),
		})
		return nil, fmt.Errorf("protected operation %q is misconfigured: %w", params.Name, err)
	}
	body, err := validateProtectedPayload(op.BodySchema, params.Payload)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension.protected_operation", "protected operation refused: payload rejected", map[string]any{
			"operation": params.Name, "subject": subject, "error": err.Error(),
		})
		return nil, fmt.Errorf("protected operation %q payload rejected: %w", params.Name, err)
	}

	secret, err := protectedSecretSource(subject, op.SecretRef)
	if err != nil || secret == "" {
		fields := map[string]any{"operation": params.Name, "subject": subject, "secret_ref": op.SecretRef}
		if err != nil {
			fields["error"] = err.Error()
		}
		utils.LogWithFields(utils.LevelError, "extension.protected_operation", "protected operation refused: secret unavailable", fields)
		return nil, fmt.Errorf("protected operation %q: secret %q is not available", params.Name, op.SecretRef)
	}
	redact := protectedSecretRedactor(secret)

	method := strings.ToUpper(op.Method)
	timeout := operatorHTTPDefaultTimeout
	if op.TimeoutMs > 0 {
		timeout = time.Duration(op.TimeoutMs) * time.Millisecond
	}
	maxBytes := operatorHTTPDefaultMaxBytes
	if op.MaxBytes > 0 {
		maxBytes = op.MaxBytes
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if op.InjectAs.Query != "" {
		query := target.Query()
		query.Set(op.InjectAs.Query, op.InjectAs.Prefix+secret)
		target.RawQuery = query.Encode()
	}
	var bodyReader io.Reader
	if body != nil {
		bodyReader = strings.NewReader(string(body))
	}
	req, err := http.NewRequestWithContext(reqCtx, method, target.String(), bodyReader)
	if err != nil {
		return nil, fmt.Errorf("protected operation %q: build request: %s", params.Name, redact(err.Error()))
	}
	for name, value := range op.Headers {
		req.Header.Set(name, value)
	}
	if body != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if op.InjectAs.Header != "" {
		req.Header.Set(op.InjectAs.Header, op.InjectAs.Prefix+secret)
	}

	utils.LogWithFields(utils.LevelInfo, "extension.protected_operation", "protected operation request", map[string]any{
		"operation": params.Name, "subject": subject, "method": method, "url": op.URL, "bytes": len(body),
	})

	client := &http.Client{
		Transport: network.GetHTTPTransport().Clone(),
		// A redirect would carry an injected header to a destination the
		// declaration never named.
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		if reqCtx.Err() != nil {
			utils.LogWithFields(utils.LevelError, "extension.protected_operation", "protected operation timed out", map[string]any{
				"operation": params.Name, "timeout_ms": timeout.Milliseconds(),
			})
			return nil, fmt.Errorf("protected operation %q timed out after %s", params.Name, timeout)
		}
		message := redact(err.Error())
		utils.LogWithFields(utils.LevelError, "extension.protected_operation", "protected operation request failed", map[string]any{
			"operation": params.Name, "error": message,
		})
		return nil, fmt.Errorf("protected operation %q request failed: %s", params.Name, message)
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.protected_operation", "response body close failed", map[string]any{
				"operation": params.Name, "error": redact(closeErr.Error()),
			})
		}
	}()

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("protected operation %q: read response: %s", params.Name, redact(err.Error()))
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("protected operation %q: response too large: exceeded %d bytes", params.Name, maxBytes)
	}

	result := &ProtectedOperationResult{
		Status:  resp.StatusCode,
		Headers: make(map[string]string, len(resp.Header)),
		Body:    redact(string(data)),
	}
	for name := range resp.Header {
		result.Headers[name] = redact(resp.Header.Get(name))
	}
	utils.LogWithFields(utils.LevelInfo, "extension.protected_operation", "protected operation response", map[string]any{
		"operation": params.Name, "subject": subject, "status": resp.StatusCode, "count": len(data),
		"redacted": result.Body != string(data),
	})
	return result, nil
}

// validateProtectedOperation checks a declaration and returns its parsed
// destination.
func validateProtectedOperation(op types.ProtectedOperationConfig) (*url.URL, error) {
	if op.Method == "" {
		return nil, fmt.Errorf("method is required")
	}
	if op.URL == "" {
		return nil, fmt.Errorf("url is required")
	}
	if op.SecretRef == "" {
		return nil, fmt.Errorf("secretRef is required")
	}
	if op.BodySchema == nil {
		return nil, fmt.Errorf("bodySchema is required")
	}
	if (op.InjectAs.Header == "") == (op.InjectAs.Query == "") {
		return nil, fmt.Errorf("injectAs must name exactly one of header or query")
	}
	target, err := url.Parse(op.URL)
	if err != nil {
		return nil, fmt.Errorf("invalid url: %w", err)
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, fmt.Errorf("only http/https destinations are allowed, got %q", target.Scheme)
	}
	if !op.AllowPrivateNetwork && tools.IsBlockedHost(target.Hostname()) {
		return nil, fmt.Errorf("private/reserved address %q (set allowPrivateNetwork to reach intranet APIs)", target.Hostname())
	}
	return target, nil
}

// validateProtectedPayload checks payload against schema and returns the body
// to send, or nil for an absent or null payload that the schema accepts.
func validateProtectedPayload(schemaMap map[string]any, payload json.RawMessage) ([]byte, error) {
	schemaJSON, err := json.Marshal(schemaMap)
	if err != nil {
		return nil, fmt.Errorf("encode bodySchema: %w", err)
	}
	var schema jsonschema.Schema
	if err := json.Unmarshal(schemaJSON, &schema); err != nil {
		return nil, fmt.Errorf("decode bodySchema: %w", err)
	}
	resolved, err := schema.Resolve(nil)
	if err != nil {
		return nil, fmt.Errorf("resolve bodySchema: %w", err)
	}
	var instance any
	trimmed := strings.TrimSpace(string(payload))
	if trimmed != "" {
		if err := json.Unmarshal([]byte(trimmed), &instance); err != nil {
			return nil, fmt.Errorf("payload is not valid JSON: %w", err)
		}
	}
	if err := resolved.Validate(instance); err != nil {
		return nil, err
	}
	if instance == nil {
		return nil, nil
	}
	return []byte(trimmed), nil
}

// protectedSecretRedactor returns a function that replaces the secret and its
// URL encodings in s. The engine never lets a string that could carry the
// secret leave DoProtectedOperation without passing through it.
func protectedSecretRedactor(secret string) func(string) string {
	forms := []string{secret, url.QueryEscape(secret), url.PathEscape(secret)}
	return func(s string) string {
		for _, form := range forms {
			s = strings.ReplaceAll(s, form, protectedOperationRedaction)
		}
		return s
	}
}
