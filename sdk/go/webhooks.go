// webhooks.go — inbound webhook registration.
//
// The engine owns the HTTP mechanics: the listener, the routing table, the
// auth check, the body cap. An extension registers a path and a handler; the
// engine calls it with the request when one arrives.
//
// Secrets never travel at registration time. An auth declaration carries a
// symbolic ref name, and the extension keeps the actual token behind a
// callback the engine invokes over engine/resolve_token only when it needs to
// verify a request. A rotating token therefore needs no re-registration.
package ion

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// AuthKind selects a webhook's authentication strategy.
type AuthKind string

const (
	// AuthNone accepts any request. Use only on a loopback interface.
	AuthNone AuthKind = "none"
	// AuthBearer reads a bearer token from the Authorization header.
	AuthBearer AuthKind = "bearer"
	// AuthSharedSecret compares a token in a named header.
	AuthSharedSecret AuthKind = "shared-secret"
	// AuthHMACSignature verifies an HMAC signature over the request body.
	AuthHMACSignature AuthKind = "hmac-signature"
)

// WebhookAuth declares how the engine authenticates a route's requests.
type WebhookAuth struct {
	// Kind selects the strategy. Required.
	Kind AuthKind `json:"kind"`
	// HeaderName is the header carrying the token or signature, for
	// shared-secret and hmac-signature. Ignored for bearer, which always
	// reads Authorization.
	HeaderName string `json:"headerName,omitempty"`
	// Algorithm names the HMAC hash for hmac-signature. Only "sha256" is
	// accepted today.
	Algorithm string `json:"algorithm,omitempty"`
	// TokenRefName is the symbolic name the engine sends back over
	// engine/resolve_token when it needs the secret. Set by the SDK from the
	// route path; do not populate it directly.
	TokenRefName string `json:"tokenRefName,omitempty"`
}

// WebhookRoute declares one inbound route.
type WebhookRoute struct {
	// Path is the URL path the engine matches exactly. Must start with "/".
	Path string `json:"path"`
	// Method is the HTTP method. Empty defaults to POST.
	Method string `json:"method,omitempty"`
	// Auth declares the authentication strategy. Required.
	Auth WebhookAuth `json:"auth"`
	// MaxBodyBytes caps the request body before the engine returns 413. Zero
	// inherits the engine default.
	MaxBodyBytes int64 `json:"maxBodyBytes,omitempty"`
	// Interface overrides the listener's bind interface. Empty inherits the
	// engine default, normally loopback.
	Interface string `json:"interface,omitempty"`
	// Concurrency is "single" (default: one instance handles the request) or
	// "all" (every instance of this extension handles it).
	Concurrency string `json:"concurrency,omitempty"`
}

// WebhookRequest is an inbound HTTP request delivered to a handler.
type WebhookRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	URL     string            `json:"url"`
	Query   string            `json:"query"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	// Remote is the client address the engine saw.
	Remote string `json:"remote"`
}

// JSON decodes the request body into v. An empty body is not an error: v is
// left untouched, so a handler that tolerates an empty POST needs no special
// case.
func (r WebhookRequest) JSON(v any) error {
	if r.Body == "" {
		return nil
	}
	return json.Unmarshal([]byte(r.Body), v)
}

// Text returns the raw request body.
func (r WebhookRequest) Text() string { return r.Body }

// WebhookResponse is what a handler returns. A zero value means 200 with an
// empty body.
type WebhookResponse struct {
	Status  int               `json:"status,omitempty"`
	Body    string            `json:"body,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

// WebhookHandler handles one inbound request.
type WebhookHandler func(c context.Context, ctx *Context, req WebhookRequest) (WebhookResponse, error)

// WebhookHandle refers to a registered route.
type WebhookHandle struct {
	// ID is the route path.
	ID  string
	reg *asyncRegistry
}

// Unregister removes the route. The engine fires webhook_deregistered, which
// cannot be vetoed.
func (h WebhookHandle) Unregister(c context.Context) error {
	return h.reg.unregisterWebhook(c, h.ID)
}

// WebhooksAPI is the webhook registration surface, reached via
// [SDK.Webhooks].
type WebhooksAPI struct{ reg *asyncRegistry }

// Register adds an inbound route.
//
// Called before [SDK.Run], the declaration rides the init handshake. Called
// afterwards it goes out as an ext/register_webhook call, and the engine fires
// the veto-capable webhook_registered hook before answering — so a policy
// extension can refuse it, and Register returns that refusal as an error.
func (w *WebhooksAPI) Register(c context.Context, route WebhookRoute, handler WebhookHandler) (WebhookHandle, error) {
	if !strings.HasPrefix(route.Path, "/") {
		return WebhookHandle{}, fmt.Errorf("ion: webhook route path must start with '/' (got %q)", route.Path)
	}
	if handler == nil {
		return WebhookHandle{}, fmt.Errorf("ion: webhook route %q has no handler", route.Path)
	}
	return w.register(c, route, handler, nil)
}

// RegisterWithToken adds a route whose auth secret is supplied lazily.
//
// The token function is invoked by the engine over engine/resolve_token when
// it verifies a request, so the secret is read at use time and never crosses
// the wire at registration. Reading it from the environment inside the
// callback is the intended pattern:
//
//	sdk.Webhooks().RegisterWithToken(c, route, handler, func() (string, error) {
//		return os.Getenv("MY_WEBHOOK_SECRET"), nil
//	})
func (w *WebhooksAPI) RegisterWithToken(
	c context.Context,
	route WebhookRoute,
	handler WebhookHandler,
	token func() (string, error),
) (WebhookHandle, error) {
	if !strings.HasPrefix(route.Path, "/") {
		return WebhookHandle{}, fmt.Errorf("ion: webhook route path must start with '/' (got %q)", route.Path)
	}
	if handler == nil {
		return WebhookHandle{}, fmt.Errorf("ion: webhook route %q has no handler", route.Path)
	}
	if token == nil && route.Auth.Kind != AuthNone {
		return WebhookHandle{}, fmt.Errorf("ion: webhook route %q declares auth %q but supplies no token provider",
			route.Path, route.Auth.Kind)
	}
	return w.register(c, route, handler, token)
}

func (w *WebhooksAPI) register(
	c context.Context,
	route WebhookRoute,
	handler WebhookHandler,
	token func() (string, error),
) (WebhookHandle, error) {
	r := w.reg

	if route.Auth.Kind == "" {
		route.Auth.Kind = AuthNone
	}
	if token != nil && route.Auth.Kind != AuthNone {
		route.Auth.TokenRefName = tokenRefNameFor(route.Path)
	}

	r.mu.Lock()
	r.webhookHandlers[route.Path] = handler
	if token != nil && route.Auth.TokenRefName != "" {
		r.tokenRefs[route.Auth.TokenRefName] = token
	}
	r.mu.Unlock()

	err := r.register(c, "ext/register_webhook", route, func() {
		r.pendingWebhooks = append(r.pendingWebhooks, route)
	})
	if err != nil {
		// The engine refused (a veto, or a duplicate path). Drop the local
		// handler so a later fire cannot reach a route the engine does not
		// have, which would be a silent divergence.
		r.mu.Lock()
		delete(r.webhookHandlers, route.Path)
		delete(r.tokenRefs, route.Auth.TokenRefName)
		r.mu.Unlock()
		r.sdk.logger.Error("webhook registration refused", map[string]any{
			"path": route.Path, "error": err.Error(),
		})
		return WebhookHandle{}, err
	}

	r.sdk.logger.Info("webhook registered", map[string]any{
		"path":   route.Path,
		"method": route.Method,
		"auth":   string(route.Auth.Kind),
	})
	return WebhookHandle{ID: route.Path, reg: r}, nil
}

// unregisterWebhook removes a route locally and, when init has completed, on
// the engine too.
func (r *asyncRegistry) unregisterWebhook(c context.Context, path string) error {
	r.mu.Lock()
	delete(r.webhookHandlers, path)
	delete(r.tokenRefs, tokenRefNameFor(path))
	if !r.sdk.initialized() {
		// Still pre-init: drop it from the queue and there is nothing for the
		// engine to forget.
		filtered := r.pendingWebhooks[:0]
		for _, route := range r.pendingWebhooks {
			if route.Path != path {
				filtered = append(filtered, route)
			}
		}
		r.pendingWebhooks = filtered
		r.mu.Unlock()
		return nil
	}
	r.mu.Unlock()

	if err := r.sdk.call(c, "ext/deregister_webhook", map[string]string{"path": path}, nil); err != nil {
		r.sdk.logger.Error("webhook deregistration failed", map[string]any{"path": path, "error": err.Error()})
		return err
	}
	r.sdk.logger.Info("webhook deregistered", map[string]any{"path": path})
	return nil
}

// buildWebhookRequest decodes an engine fire payload into a WebhookRequest.
func buildWebhookRequest(payload json.RawMessage) WebhookRequest {
	var req WebhookRequest
	if len(payload) > 0 {
		// A decode failure yields the zero request rather than dropping the
		// fire: the handler still runs and can see the empty body, which is
		// more debuggable than a silently missing invocation.
		_ = json.Unmarshal(payload, &req) //nolint:errcheck // zero request is the deliberate fallback
	}
	if req.Headers == nil {
		req.Headers = map[string]string{}
	}
	return req
}

// normaliseWebhookResponse applies the engine's defaults to a handler result.
func normaliseWebhookResponse(resp WebhookResponse) WebhookResponse {
	if resp.Status == 0 {
		resp.Status = 200
	}
	return resp
}
