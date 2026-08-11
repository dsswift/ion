// http.go — pre-authenticated outbound HTTP.
//
// The engine performs the request and mints the operator token for the
// declared scope, injecting the Authorization header on its way out. The token
// never enters the extension process, so an extension can call an
// operator-authenticated endpoint without ever holding the credential.
//
// The RPC is session-independent: minting a token needs no session state, so
// this works from a schedule or webhook firing as well as from a hook.
package ion

import (
	"context"
	"encoding/json"
	"fmt"
)

// HTTPRequestOptions configures one outbound request.
type HTTPRequestOptions struct {
	// Scope names the operator token scope to mint. Empty sends no
	// Authorization header.
	Scope string `json:"scope,omitempty"`
	// Audience is the token audience, when the scope requires one.
	Audience string `json:"audience,omitempty"`
	// Headers are extra request headers. The engine adds Authorization
	// itself; setting it here is overwritten.
	Headers map[string]string `json:"headers,omitempty"`
	// Body is the request body.
	Body string `json:"body,omitempty"`
	// TimeoutMs bounds the request. Zero uses the engine default.
	TimeoutMs float64 `json:"timeoutMs,omitempty"`
	// MaxBytes caps the response the engine will read. Zero uses the engine
	// default.
	MaxBytes int64 `json:"maxBytes,omitempty"`
	// AllowPrivateNetwork permits a request to a private address. Off by
	// default: an extension that can reach RFC1918 space through the engine
	// is an SSRF vector, so it must be opted into per call.
	AllowPrivateNetwork bool `json:"allowPrivateNetwork,omitempty"`
}

// HTTPResponse is a completed outbound request.
type HTTPResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body"`
}

// JSON decodes the response body into v.
func (r HTTPResponse) JSON(v any) error {
	if r.Body == "" {
		return fmt.Errorf("ion: cannot decode an empty response body (status %d)", r.Status)
	}
	return json.Unmarshal([]byte(r.Body), v)
}

// HTTPAPI is the outbound HTTP surface, reached via [Context.HTTP].
type HTTPAPI struct{ ctx *Context }

// HTTP returns the pre-authenticated outbound HTTP surface.
func (c *Context) HTTP() *HTTPAPI { return &HTTPAPI{ctx: c} }

// Request performs an outbound request with an arbitrary method.
func (h *HTTPAPI) Request(ctx context.Context, method, url string, opts HTTPRequestOptions) (HTTPResponse, error) {
	if url == "" {
		return HTTPResponse{}, fmt.Errorf("ion: HTTP request requires a url")
	}
	params := map[string]any{
		"method":              method,
		"url":                 url,
		"scope":               opts.Scope,
		"audience":            opts.Audience,
		"body":                opts.Body,
		"timeoutMs":           opts.TimeoutMs,
		"maxBytes":            opts.MaxBytes,
		"allowPrivateNetwork": opts.AllowPrivateNetwork,
	}
	if len(opts.Headers) > 0 {
		params["headers"] = opts.Headers
	}

	var out HTTPResponse
	if err := h.ctx.sdk.call(ctx, "ext/http_request", params, &out); err != nil {
		h.ctx.sdk.logger.Error("outbound http request failed", map[string]any{
			"method": method, "url": url, "error": err.Error(),
		})
		return HTTPResponse{}, err
	}
	h.ctx.sdk.logger.Debug("outbound http request completed", map[string]any{
		"method": method, "url": url, "status": out.Status, "bytes": len(out.Body),
	})
	return out, nil
}

// Get performs a GET.
func (h *HTTPAPI) Get(ctx context.Context, url string, opts HTTPRequestOptions) (HTTPResponse, error) {
	return h.Request(ctx, "GET", url, opts)
}

// Post performs a POST.
func (h *HTTPAPI) Post(ctx context.Context, url string, opts HTTPRequestOptions) (HTTPResponse, error) {
	return h.Request(ctx, "POST", url, opts)
}

// Put performs a PUT.
func (h *HTTPAPI) Put(ctx context.Context, url string, opts HTTPRequestOptions) (HTTPResponse, error) {
	return h.Request(ctx, "PUT", url, opts)
}

// Patch performs a PATCH.
func (h *HTTPAPI) Patch(ctx context.Context, url string, opts HTTPRequestOptions) (HTTPResponse, error) {
	return h.Request(ctx, "PATCH", url, opts)
}

// Delete performs a DELETE.
func (h *HTTPAPI) Delete(ctx context.Context, url string, opts HTTPRequestOptions) (HTTPResponse, error) {
	return h.Request(ctx, "DELETE", url, opts)
}
