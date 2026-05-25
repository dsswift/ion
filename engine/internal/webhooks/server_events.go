// Event-emission helpers for the webhook server. Each function
// publishes a single engine_webhook_* or engine_async_fire_dropped
// event so the desktop / iOS can render an audit log.
//
// Extracted from server.go to keep the main dispatch pipeline focused
// on routing and handler invocation.

package webhooks

import (
	"net/http"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// emitWebhookReceived publishes engine_webhook_received for the given
// request. Engine-internal observability — consumers (desktop / iOS)
// render an audit-log view if they want.
func (s *Server) emitWebhookReceived(reqID string, route extension.WebhookRoute, r *http.Request) {
	s.publishEvent(types.EngineEvent{
		Type:           "engine_webhook_received",
		AsyncKind:      string(asyncreg.KindWebhook),
		AsyncID:        route.Path,
		AsyncRequestID: reqID,
		AsyncMethod:    r.Method,
		AsyncPath:      route.Path,
	})
}

func (s *Server) emitWebhookAuthenticated(reqID string, route extension.WebhookRoute, r *http.Request) {
	s.publishEvent(types.EngineEvent{
		Type:           "engine_webhook_authenticated",
		AsyncKind:      string(asyncreg.KindWebhook),
		AsyncID:        route.Path,
		AsyncRequestID: reqID,
		AsyncMethod:    r.Method,
		AsyncPath:      route.Path,
	})
}

func (s *Server) emitWebhookResponded(reqID string, route extension.WebhookRoute, r *http.Request, status int, start time.Time) {
	s.publishEvent(types.EngineEvent{
		Type:            "engine_webhook_responded",
		AsyncKind:       string(asyncreg.KindWebhook),
		AsyncID:         route.Path,
		AsyncRequestID:  reqID,
		AsyncMethod:     r.Method,
		AsyncPath:       route.Path,
		AsyncStatus:     status,
		AsyncDurationMs: time.Since(start).Milliseconds(),
	})
}

func (s *Server) emitWebhookError(reqID, id, method, path string, status int, reason string, start time.Time) {
	s.publishEvent(types.EngineEvent{
		Type:            "engine_webhook_handler_error",
		AsyncKind:       string(asyncreg.KindWebhook),
		AsyncID:         id,
		AsyncRequestID:  reqID,
		AsyncMethod:     method,
		AsyncPath:       path,
		AsyncStatus:     status,
		AsyncReason:     reason,
		AsyncDurationMs: time.Since(start).Milliseconds(),
	})
}

func (s *Server) emitAsyncFireDropped(kind, id, reason string) {
	s.publishEvent(types.EngineEvent{
		Type:        "engine_async_fire_dropped",
		AsyncKind:   kind,
		AsyncID:     id,
		AsyncReason: reason,
	})
}

func (s *Server) publishEvent(ev types.EngineEvent) {
	s.mu.RLock()
	fn := s.emit
	s.mu.RUnlock()
	if fn != nil {
		fn(ev)
	}
}
