// async.go — the shared registry behind webhooks and schedules.
//
// Both surfaces have the same lifecycle. A registration made before the engine
// sends init is queued and delivered inside the init response; one made after
// goes out as its own ext/register_* call. Either way the handler is stored
// locally, keyed by (kind, id), and the engine later reaches it with an
// engine/fire_async request.
//
// The post-init path is where the reentrancy requirement comes from: the
// engine fires the veto-capable webhook_registered hook back at the extension
// before answering ext/register_webhook. The transport serves inbound requests
// on their own goroutines, so the hook is handled while the registration call
// is still pending.
package ion

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
)

// asyncRegistry holds webhook and schedule handlers plus the lazily-resolved
// token and predicate callbacks the engine asks for by name.
type asyncRegistry struct {
	sdk *SDK

	mu               sync.RWMutex
	webhookHandlers  map[string]WebhookHandler
	scheduleHandlers map[string]ScheduleHandler
	// onceJobs tracks ids registered through Schedule().Once so the fire
	// dispatcher can drop the local handler after its single invocation.
	// The engine deregisters on its side; this mirrors that so a lingering
	// tick finds no handler.
	onceJobs map[string]bool

	// tokenRefs and predicateRefs hold callbacks the engine resolves on
	// demand. A secret never crosses the wire at registration time — the
	// engine asks for it by symbolic name when it needs one.
	tokenRefs     map[string]func() (string, error)
	predicateRefs map[string]func() (bool, error)

	pendingWebhooks  []WebhookRoute
	pendingSchedules []ScheduleJob
}

func newAsyncRegistry(s *SDK) *asyncRegistry {
	return &asyncRegistry{
		sdk:              s,
		webhookHandlers:  make(map[string]WebhookHandler),
		scheduleHandlers: make(map[string]ScheduleHandler),
		onceJobs:         make(map[string]bool),
		tokenRefs:        make(map[string]func() (string, error)),
		predicateRefs:    make(map[string]func() (bool, error)),
	}
}

// drainPendingInit returns the queued declarations for the init response and
// clears the queues.
func (r *asyncRegistry) drainPendingInit() ([]WebhookRoute, []ScheduleJob) {
	r.mu.Lock()
	defer r.mu.Unlock()
	webhooks, schedules := r.pendingWebhooks, r.pendingSchedules
	r.pendingWebhooks, r.pendingSchedules = nil, nil
	return webhooks, schedules
}

// fireAsyncParams is the inbound engine/fire_async shape.
type fireAsyncParams struct {
	Kind       string          `json:"kind"`
	ID         string          `json:"id"`
	SessionKey string          `json:"sessionKey"`
	Payload    json.RawMessage `json:"payload"`
}

// handleFireAsync dispatches a webhook or schedule firing to its handler.
func (r *asyncRegistry) handleFireAsync(c context.Context, id *int64, params json.RawMessage) {
	var p fireAsyncParams
	if err := json.Unmarshal(params, &p); err != nil {
		r.sdk.logger.Error("fire_async params did not decode", map[string]any{"error": err.Error()})
		if id != nil {
			r.sdk.transport.respondError(*id, CodeInvalidParams, "parse error: "+err.Error())
		}
		return
	}

	// A fire arrives outside any hook, so there is no _ctx envelope; build a
	// context carrying the session key the engine supplied.
	ctx := r.sdk.newContext(nil)
	ctx.SessionKey = p.SessionKey
	// No batch is opened: a fire_async response carries the handler's own
	// result shape and no events array, so an Emit from a webhook or schedule
	// handler goes straight out as its own notification.

	switch p.Kind {
	case "webhook":
		r.fireWebhook(c, ctx, id, p)
	case "schedule":
		r.fireSchedule(c, ctx, id, p)
	default:
		r.sdk.logger.Warn("fire_async for unknown kind", map[string]any{"kind": p.Kind, "id": p.ID})
		if id != nil {
			r.sdk.transport.respondError(*id, CodeInvalidParams, "fire_async: unknown kind "+p.Kind)
		}
	}
}

func (r *asyncRegistry) fireWebhook(c context.Context, ctx *Context, id *int64, p fireAsyncParams) {
	r.mu.RLock()
	handler, ok := r.webhookHandlers[p.ID]
	r.mu.RUnlock()
	if !ok {
		r.sdk.logger.Warn("webhook fired with no registered handler", map[string]any{"path": p.ID})
		if id != nil {
			r.sdk.transport.respondError(*id, CodeHandlerError, "no webhook handler for "+p.ID)
		}
		return
	}

	req := buildWebhookRequest(p.Payload)
	resp, err := handler(c, ctx, req)
	if err != nil {
		r.sdk.logger.Error("webhook handler failed", map[string]any{"path": p.ID, "error": err.Error()})
		if id != nil {
			r.sdk.transport.respondError(*id, CodeHandlerError, err.Error())
		}
		return
	}
	if id != nil {
		r.sdk.transport.respond(*id, normaliseWebhookResponse(resp))
	}
}

func (r *asyncRegistry) fireSchedule(c context.Context, ctx *Context, id *int64, p fireAsyncParams) {
	r.mu.RLock()
	handler, ok := r.scheduleHandlers[p.ID]
	isOnce := r.onceJobs[p.ID]
	r.mu.RUnlock()
	if !ok {
		r.sdk.logger.Warn("schedule fired with no registered handler", map[string]any{"job": p.ID})
		if id != nil {
			r.sdk.transport.respondError(*id, CodeHandlerError, "no schedule handler for "+p.ID)
		}
		return
	}

	var meta ScheduleFireMeta
	if len(p.Payload) > 0 {
		if err := json.Unmarshal(p.Payload, &meta); err != nil {
			r.sdk.logger.Warn("schedule fire metadata did not decode; handler sees zero values",
				map[string]any{"job": p.ID, "error": err.Error()})
		}
	}

	control := ScheduleControl{
		JobID: p.ID,
		unregister: func(c context.Context) error {
			return r.unregisterSchedule(c, p.ID)
		},
	}

	err := handler(c, ctx, control, meta)

	// A once job fires exactly once. The engine drops it from its registry;
	// mirror that locally so a stale tick finds no handler.
	if isOnce {
		r.mu.Lock()
		delete(r.scheduleHandlers, p.ID)
		delete(r.predicateRefs, predicateRefName(p.ID))
		delete(r.onceJobs, p.ID)
		r.mu.Unlock()
	}

	if err != nil {
		r.sdk.logger.Error("schedule handler failed", map[string]any{"job": p.ID, "error": err.Error()})
		if id != nil {
			r.sdk.transport.respondError(*id, CodeHandlerError, err.Error())
		}
		return
	}
	if id != nil {
		r.sdk.transport.respond(*id, map[string]bool{"ok": true})
	}
}

// resolveNameParams is the inbound shape of both resolve RPCs.
type resolveNameParams struct {
	Name string `json:"name"`
}

// handleResolveToken answers engine/resolve_token by invoking the callback the
// extension registered alongside a webhook's auth declaration.
func (r *asyncRegistry) handleResolveToken(_ context.Context, id *int64, params json.RawMessage) {
	if id == nil {
		return
	}
	var p resolveNameParams
	if err := json.Unmarshal(params, &p); err != nil {
		r.sdk.transport.respondError(*id, CodeInvalidParams, "parse error: "+err.Error())
		return
	}
	r.mu.RLock()
	fn, ok := r.tokenRefs[p.Name]
	r.mu.RUnlock()
	if !ok {
		// An unknown ref is not fatal: the engine treats an empty token as
		// "no credential", which fails the auth check rather than the route.
		r.sdk.logger.Warn("token ref requested but not registered", map[string]any{"ref": p.Name})
		r.sdk.transport.respond(*id, map[string]string{"value": ""})
		return
	}
	value, err := fn()
	if err != nil {
		r.sdk.logger.Error("token provider failed", map[string]any{"ref": p.Name, "error": err.Error()})
		r.sdk.transport.respondError(*id, CodeHandlerError, err.Error())
		return
	}
	r.sdk.transport.respond(*id, map[string]string{"value": value})
}

// handleResolvePredicate answers engine/resolve_predicate by invoking a
// schedule's enabled() callback. An unregistered name resolves to enabled,
// matching the TypeScript runtime: a schedule with no predicate always runs.
func (r *asyncRegistry) handleResolvePredicate(_ context.Context, id *int64, params json.RawMessage) {
	if id == nil {
		return
	}
	var p resolveNameParams
	if err := json.Unmarshal(params, &p); err != nil {
		r.sdk.transport.respondError(*id, CodeInvalidParams, "parse error: "+err.Error())
		return
	}
	r.mu.RLock()
	fn, ok := r.predicateRefs[p.Name]
	r.mu.RUnlock()
	if !ok {
		r.sdk.transport.respond(*id, map[string]bool{"enabled": true})
		return
	}
	enabled, err := fn()
	if err != nil {
		r.sdk.logger.Error("schedule predicate failed", map[string]any{"ref": p.Name, "error": err.Error()})
		r.sdk.transport.respondError(*id, CodeHandlerError, err.Error())
		return
	}
	r.sdk.transport.respond(*id, map[string]bool{"enabled": enabled})
}

// register queues a declaration or sends it as an RPC, depending on whether
// init has completed.
func (r *asyncRegistry) register(c context.Context, method string, decl any, queue func()) error {
	if !r.sdk.initialized() {
		r.mu.Lock()
		queue()
		r.mu.Unlock()
		return nil
	}
	return r.sdk.call(c, method, decl, nil)
}

func predicateRefName(jobID string) string { return fmt.Sprintf("schedule:%s:enabled", jobID) }

func tokenRefNameFor(path string) string { return fmt.Sprintf("webhook:%s:token", path) }
