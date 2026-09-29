// resources_transfer.go — moving a conversation's resources to another machine.
//
// When a conversation moves, the engine asks the producing extension to hand
// over its items for that conversation (resource/export), gives them to the
// same extension on the other machine (resource/import), and then tells the
// first one to drop them (resource/forget). The engine stores nothing, so
// each step is the extension's own store doing the work.
//
// A kind with no handler for an operation answers CodeMethodNotFound, which
// the engine reads as "this producer cannot do that": export then falls back
// to the query handler, and a destination that cannot import makes the move
// refuse rather than lose the items.
package ion

import (
	"context"
	"encoding/json"
)

const (
	methodResourceExport = "resource/export"
	methodResourceImport = "resource/import"
	methodResourceForget = "resource/forget"
)

// ResourceExportHandler returns every item of a kind held for the given
// conversations, with full content.
type ResourceExportHandler func(c context.Context, conversationIDs []string) ([]ResourceItem, error)

// ResourceImportResult is an import's answer: the item IDs persisted, and the
// ones refused with a reason.
type ResourceImportResult struct {
	Accepted []string                `json:"accepted"`
	Refused  []ResourceImportRefusal `json:"refused,omitempty"`
}

// ResourceImportRefusal names an item the extension would not take.
type ResourceImportRefusal struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// ResourceImportHandler persists items the same extension exported on another
// machine.
type ResourceImportHandler func(c context.Context, items []ResourceItem) (ResourceImportResult, error)

// ResourceForgetHandler drops every item of a kind held for the given
// conversations and returns how many it removed.
type ResourceForgetHandler func(c context.Context, conversationIDs []string) (int, error)

// resourceTransferHandlers holds one kind's transfer handlers.
type resourceTransferHandlers struct {
	export ResourceExportHandler
	imp    ResourceImportHandler
	forget ResourceForgetHandler
}

// OnExport registers the handler that hands over a kind's items for the given
// conversations. Without it, the engine reads them through OnQuery instead.
func (a *ResourcesAPI) OnExport(kind string, handler ResourceExportHandler) {
	a.reg.setTransfer(kind, func(h *resourceTransferHandlers) { h.export = handler })
}

// OnImport registers the handler that persists a kind's items exported by the
// same extension elsewhere. Without it, a conversation holding items of this
// kind cannot move to this machine.
func (a *ResourcesAPI) OnImport(kind string, handler ResourceImportHandler) {
	a.reg.setTransfer(kind, func(h *resourceTransferHandlers) { h.imp = handler })
}

// OnForget registers the handler that drops a kind's items for the given
// conversations once they have moved away.
func (a *ResourcesAPI) OnForget(kind string, handler ResourceForgetHandler) {
	a.reg.setTransfer(kind, func(h *resourceTransferHandlers) { h.forget = handler })
}

func (r *resourceRegistry) setTransfer(kind string, set func(*resourceTransferHandlers)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.transfer == nil {
		r.transfer = make(map[string]*resourceTransferHandlers)
	}
	h := r.transfer[kind]
	if h == nil {
		h = &resourceTransferHandlers{}
		r.transfer[kind] = h
	}
	set(h)
}

func (r *resourceRegistry) transferFor(kind string) resourceTransferHandlers {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if h := r.transfer[kind]; h != nil {
		return *h
	}
	return resourceTransferHandlers{}
}

// resourceTransferParams is the inbound shape of all three methods.
type resourceTransferParams struct {
	Kind            string         `json:"kind"`
	ConversationIDs []string       `json:"conversationIds"`
	Items           []ResourceItem `json:"items"`
}

// handleTransfer answers resource/export, resource/import, or resource/forget.
func (r *resourceRegistry) handleTransfer(c context.Context, id *int64, method string, params json.RawMessage) {
	if id == nil {
		return
	}
	var p resourceTransferParams
	if err := json.Unmarshal(params, &p); err != nil {
		r.sdk.logger.Error("resource transfer params did not decode", map[string]any{"method": method, "error": err.Error()})
		r.sdk.transport.respondError(*id, CodeInvalidParams, "parse error: "+err.Error())
		return
	}
	fields := map[string]any{"method": method, "kind": p.Kind}
	h := r.transferFor(p.Kind)
	unsupported := func() {
		r.sdk.logger.Debug("resource transfer: no handler for kind", fields)
		r.sdk.transport.respondError(*id, CodeMethodNotFound, "no "+method+" handler for kind "+p.Kind)
	}
	fail := func(err error) {
		r.sdk.logger.Error("resource transfer handler failed", map[string]any{"method": method, "kind": p.Kind, "error": err.Error()})
		r.sdk.transport.respondError(*id, CodeHandlerError, err.Error())
	}

	switch method {
	case methodResourceExport:
		if h.export == nil {
			unsupported()
			return
		}
		items, err := h.export(c, p.ConversationIDs)
		if err != nil {
			fail(err)
			return
		}
		if items == nil {
			items = []ResourceItem{}
		}
		r.sdk.logger.Info("resource export answered", map[string]any{"kind": p.Kind, "items": len(items)})
		r.sdk.transport.respond(*id, items)
	case methodResourceImport:
		if h.imp == nil {
			unsupported()
			return
		}
		result, err := h.imp(c, p.Items)
		if err != nil {
			fail(err)
			return
		}
		if result.Accepted == nil {
			result.Accepted = []string{}
		}
		r.sdk.logger.Info("resource import answered", map[string]any{"kind": p.Kind, "items": len(p.Items), "accepted": len(result.Accepted)})
		r.sdk.transport.respond(*id, result)
	case methodResourceForget:
		if h.forget == nil {
			unsupported()
			return
		}
		removed, err := h.forget(c, p.ConversationIDs)
		if err != nil {
			fail(err)
			return
		}
		r.sdk.logger.Info("resource forget answered", map[string]any{"kind": p.Kind, "removed": removed})
		r.sdk.transport.respond(*id, map[string]int{"removed": removed})
	}
}
