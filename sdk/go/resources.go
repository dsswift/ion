// resources.go — the resource subsystem.
//
// A resource is durable structured content an extension produces and clients
// subscribe to: a briefing, a report, a notification inbox item. The engine
// routes and fans out; it stores nothing. When a client subscribes, the engine
// sends resource/query to the producing extension, which answers from its own
// store — so persistence is the producer's job, and a resource survives an
// engine restart only if the extension made it survive.
//
// Scoping follows the item's ConversationID: set, and the resource belongs to
// that conversation and shows in its attachments; empty, and it is
// workspace-scoped and shows in the global inbox.
package ion

import (
	"context"
	"encoding/json"
	"sync"
)

// ResourceItem is one piece of durable structured content.
type ResourceItem struct {
	// ID is the item's identifier within its kind.
	ID string `json:"id"`
	// Kind is the resource kind, matching a declaration.
	Kind string `json:"kind"`
	// Title is a short label for client display.
	Title string `json:"title,omitempty"`
	// Content is the item's body.
	Content string `json:"content"`
	// CreatedAt is an RFC3339 timestamp.
	CreatedAt string `json:"createdAt"`
	// ConversationID scopes the item to a conversation. Empty makes it
	// workspace-scoped.
	ConversationID string `json:"conversationId,omitempty"`
	// Metadata is an opaque map forwarded verbatim to clients.
	Metadata map[string]any `json:"metadata,omitempty"`
	// UpdatedAt is an RFC3339 timestamp of the last change.
	UpdatedAt string `json:"updatedAt,omitempty"`
	// Read is the item's read state. The engine does not track this: a
	// client marks an item read by publishing a mark_read delta, which the
	// engine fans out to every subscriber, and the producer persists it if
	// it chooses to.
	Read bool `json:"read,omitempty"`
}

// ResourceOp is the kind of change a publish carries.
type ResourceOp string

const (
	// ResourceOpCreate adds an item.
	ResourceOpCreate ResourceOp = "create"
	// ResourceOpUpdate replaces an item.
	ResourceOpUpdate ResourceOp = "update"
	// ResourceOpDelete removes an item.
	ResourceOpDelete ResourceOp = "delete"
	// ResourceOpMarkRead flips an item's read state. Sent by clients and
	// fanned out to every subscriber, so both devices agree.
	ResourceOpMarkRead ResourceOp = "mark_read"
)

// ResourceFilter scopes a query.
type ResourceFilter struct {
	Kind           string `json:"kind"`
	ConversationID string `json:"conversationId,omitempty"`
	// Since is an RFC3339 timestamp; only items changed after it.
	Since string `json:"since,omitempty"`
	// Limit caps the returned item count. Zero means no cap.
	Limit int `json:"limit,omitempty"`
}

// ResourceDeclaration declares a kind this extension produces. One producer
// per kind per session.
type ResourceDeclaration struct {
	Kind string `json:"kind"`
}

// ResourceQueryHandler answers a client's subscription with the current
// snapshot for a kind.
type ResourceQueryHandler func(c context.Context, filter ResourceFilter) ([]ResourceItem, error)

// ResourceHandle publishes deltas for a declared kind.
type ResourceHandle struct {
	// Kind is the declared resource kind.
	Kind string
	reg  *resourceRegistry
}

// Publish sends a delta. The engine fans it out to every subscribed client,
// desktop and mobile alike.
func (h ResourceHandle) Publish(c context.Context, op ResourceOp, item ResourceItem) error {
	if item.Kind == "" {
		item.Kind = h.Kind
	}
	err := h.reg.sdk.call(c, "ext/publish_resource", map[string]any{
		"kind": h.Kind,
		"op":   string(op),
		"item": item,
	}, nil)
	if err != nil {
		h.reg.sdk.logger.Error("resource publish failed", map[string]any{
			"kind": h.Kind, "op": string(op), "id": item.ID, "error": err.Error(),
		})
		return err
	}
	h.reg.sdk.logger.Debug("resource published", map[string]any{
		"kind": h.Kind, "op": string(op), "id": item.ID,
	})
	return nil
}

// resourceRegistry holds query handlers and the pre-init declaration queue.
type resourceRegistry struct {
	sdk *SDK

	mu       sync.RWMutex
	handlers map[string]ResourceQueryHandler
	pending  []ResourceDeclaration
}

func newResourceRegistry(s *SDK) *resourceRegistry {
	return &resourceRegistry{sdk: s, handlers: make(map[string]ResourceQueryHandler)}
}

// drainPendingInit returns the queued declarations for the init response.
func (r *resourceRegistry) drainPendingInit() []ResourceDeclaration {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.pending
	r.pending = nil
	return out
}

// resourceQueryParams is the inbound resource/query shape.
type resourceQueryParams struct {
	Kind   string         `json:"kind"`
	Filter ResourceFilter `json:"filter"`
}

// handleQuery answers a resource/query, which the engine sends when a client
// subscribes to a kind this extension produces.
func (r *resourceRegistry) handleQuery(c context.Context, id *int64, params json.RawMessage) {
	if id == nil {
		return
	}
	var p resourceQueryParams
	if err := json.Unmarshal(params, &p); err != nil {
		r.sdk.logger.Error("resource query params did not decode", map[string]any{"error": err.Error()})
		r.sdk.transport.respondError(*id, CodeInvalidParams, "parse error: "+err.Error())
		return
	}

	r.mu.RLock()
	handler, ok := r.handlers[p.Kind]
	r.mu.RUnlock()
	if !ok {
		// No handler for a kind we declared means the extension has nothing
		// to show yet; an empty snapshot is the correct answer, not an error.
		r.sdk.logger.Debug("resource query for kind with no handler; answering empty",
			map[string]any{"kind": p.Kind})
		r.sdk.transport.respond(*id, []ResourceItem{})
		return
	}

	// The filter's Kind is authoritative; fill it in when the engine sent it
	// only at the top level.
	if p.Filter.Kind == "" {
		p.Filter.Kind = p.Kind
	}

	items, err := handler(c, p.Filter)
	if err != nil {
		r.sdk.logger.Error("resource query handler failed", map[string]any{"kind": p.Kind, "error": err.Error()})
		r.sdk.transport.respondError(*id, CodeHandlerError, err.Error())
		return
	}
	if items == nil {
		items = []ResourceItem{}
	}
	r.sdk.logger.Debug("resource query answered", map[string]any{"kind": p.Kind, "items": len(items)})
	r.sdk.transport.respond(*id, items)
}

// ResourcesAPI is the resource surface, reached via [SDK.Resources].
type ResourcesAPI struct{ reg *resourceRegistry }

// Declare registers this extension as the producer for a kind and returns a
// handle for publishing.
//
// Declaring before [SDK.Run] rides the init handshake; declaring afterwards
// goes out as an ext/declare_resource call.
func (a *ResourcesAPI) Declare(c context.Context, kind string) (ResourceHandle, error) {
	decl := ResourceDeclaration{Kind: kind}

	if !a.reg.sdk.initialized() {
		a.reg.mu.Lock()
		a.reg.pending = append(a.reg.pending, decl)
		a.reg.mu.Unlock()
		a.reg.sdk.logger.Debug("resource kind queued for init", map[string]any{"kind": kind})
		return ResourceHandle{Kind: kind, reg: a.reg}, nil
	}

	if err := a.reg.sdk.call(c, "ext/declare_resource", decl, nil); err != nil {
		a.reg.sdk.logger.Error("resource declaration failed", map[string]any{"kind": kind, "error": err.Error()})
		return ResourceHandle{}, err
	}
	a.reg.sdk.logger.Info("resource kind declared", map[string]any{"kind": kind})
	return ResourceHandle{Kind: kind, reg: a.reg}, nil
}

// OnQuery registers the handler that answers subscriptions for a kind. The
// engine calls it whenever a client subscribes, so the handler must be able to
// produce the current snapshot from the extension's own store.
func (a *ResourcesAPI) OnQuery(kind string, handler ResourceQueryHandler) {
	a.reg.mu.Lock()
	defer a.reg.mu.Unlock()
	a.reg.handlers[kind] = handler
}
