package resource

import (
	"errors"
	"sort"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Moving a conversation to another machine moves the resources producers
// hold for it. The engine stores no resource, so it cannot copy them itself:
// it asks each producer to hand over its items for the conversation
// (export), hands them to the same-named producer on the other side
// (import), and tells the first producer to drop them once the move is done
// (forget). The engine carries the bytes between those calls and decides
// nothing about them; each producer owns how it persists its items.

// ErrTransferUnsupported is returned by a transfer handler when the producer
// has not implemented that operation.
var ErrTransferUnsupported = errors.New("resource producer does not support this operation")

// TransferHandlers are a producer's optional transfer operations. A nil
// handler is the same as one that returns ErrTransferUnsupported.
type TransferHandlers struct {
	// Export returns every item the producer holds for the given
	// conversations, with full content.
	Export func(conversationIDs []string) ([]types.ResourceItem, error)
	// Import persists items exported by the same-named producer elsewhere.
	Import func(items []types.ResourceItem) (ImportResult, error)
	// Forget drops every item the producer holds for the given conversations.
	Forget func(conversationIDs []string) (int, error)
}

// ImportResult is one producer's answer to an import.
type ImportResult struct {
	Accepted []string        `json:"accepted"`
	Refused  []ImportRefusal `json:"refused,omitempty"`
}

// ImportRefusal names an item a producer would not take, and why.
type ImportRefusal struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// ProducerExport is one producer's items for an export.
type ProducerExport struct {
	Kind     string               `json:"kind"`
	Producer string               `json:"producer"`
	Items    []types.ResourceItem `json:"items"`
	// ExportSupported is false when the producer has no export handler and
	// its items were read through its query handler instead. Such a producer
	// may still hand back items without content.
	ExportSupported bool `json:"exportSupported"`
	// Error is set when the producer failed; Items is then empty.
	Error string `json:"error,omitempty"`
}

// ItemImport is the outcome for one imported item.
type ItemImport struct {
	Kind     string `json:"kind"`
	Producer string `json:"producer"`
	ID       string `json:"id"`
	// Outcome is "accepted", "refused", "no_producer", "unsupported", or "failed".
	Outcome string `json:"outcome"`
	Reason  string `json:"reason,omitempty"`
}

// ProducerForget is one producer's answer to a forget.
type ProducerForget struct {
	Kind     string `json:"kind"`
	Producer string `json:"producer"`
	// Outcome is "forgotten", "unsupported", or "failed".
	Outcome string `json:"outcome"`
	Removed int    `json:"removed"`
	Error   string `json:"error,omitempty"`
}

// SetTransferHandlersFor wires one trusted producer's transfer operations.
func (b *Broker) SetTransferHandlersFor(kind, producer string, handlers TransferHandlers) {
	b.mu.RLock()
	entry := b.producers[kind][producer]
	b.mu.RUnlock()
	if entry == nil {
		utils.LogWithFields(utils.LevelInfo, "resource", "set transfer handlers: no producer", map[string]any{"kind": kind, "producer": producer})
		return
	}
	fph, ok := entry.host.(*FuncProducerHost)
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "resource", "set transfer handlers: producer host takes no handlers", map[string]any{"kind": kind, "producer": producer})
		return
	}
	fph.mu.Lock()
	fph.transfer = handlers
	fph.mu.Unlock()
	utils.LogWithFields(utils.LevelDebug, "resource", "transfer handlers set", map[string]any{"kind": kind, "producer": producer})
}

// transferHandlers returns the producer's transfer handlers, or none.
func (e *producerEntry) transferHandlers() TransferHandlers {
	fph, ok := e.host.(*FuncProducerHost)
	if !ok {
		return TransferHandlers{}
	}
	fph.mu.RLock()
	defer fph.mu.RUnlock()
	return fph.transfer
}

// sortedEntries returns every producer entry, ordered by kind then producer.
func (b *Broker) sortedEntries() []*producerEntry {
	b.mu.RLock()
	defer b.mu.RUnlock()
	var out []*producerEntry
	for _, byProducer := range b.producers {
		for _, entry := range byProducer {
			out = append(out, entry)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].kind != out[j].kind {
			return out[i].kind < out[j].kind
		}
		return out[i].producer < out[j].producer
	})
	return out
}

// ExportConversations asks every producer for its items for the given
// conversations. A producer without an export handler is read through its
// query handler, one conversation at a time. A producer that holds nothing
// for them is omitted.
func (b *Broker) ExportConversations(conversationIDs []string) []ProducerExport {
	var out []ProducerExport
	for _, entry := range b.sortedEntries() {
		fields := map[string]any{"kind": entry.kind, "producer": entry.producer, "count": len(conversationIDs)}
		export := ProducerExport{Kind: entry.kind, Producer: entry.producer, ExportSupported: true}
		items, err := b.exportFrom(entry, conversationIDs)
		if errors.Is(err, ErrTransferUnsupported) {
			export.ExportSupported = false
			items, err = b.queryConversations(entry, conversationIDs)
		}
		if err != nil {
			export.Error = err.Error()
			utils.LogWithFields(utils.LevelWarn, "resource", "export: producer failed", mergeLogFields(fields, map[string]any{"error": err.Error()}))
			out = append(out, export)
			continue
		}
		if len(items) == 0 {
			continue
		}
		for i := range items {
			items[i].Kind = entry.kind
			items[i].Producer = entry.producer
		}
		export.Items = items
		utils.LogWithFields(utils.LevelInfo, "resource", "export: producer answered", mergeLogFields(fields, map[string]any{"items": len(items), "export_supported": export.ExportSupported}))
		out = append(out, export)
	}
	return out
}

func (b *Broker) exportFrom(entry *producerEntry, conversationIDs []string) ([]types.ResourceItem, error) {
	handlers := entry.transferHandlers()
	if handlers.Export == nil {
		return nil, ErrTransferUnsupported
	}
	return handlers.Export(conversationIDs)
}

func (b *Broker) queryConversations(entry *producerEntry, conversationIDs []string) ([]types.ResourceItem, error) {
	var items []types.ResourceItem
	for _, id := range conversationIDs {
		got, err := entry.host.HandleQuery(types.ResourceFilter{Kind: entry.kind, Producer: entry.producer, ConversationID: id})
		if err != nil {
			return nil, err
		}
		for _, item := range got {
			// A producer's query may ignore the filter; keep only this conversation's.
			if item.ConversationID == id {
				items = append(items, item)
			}
		}
	}
	return items, nil
}

// ImportItems hands each item to the producer with the same kind and name.
// Every item gets an outcome; nothing is imported for a producer that is not
// loaded here or cannot import.
func (b *Broker) ImportItems(items []types.ResourceItem) []ItemImport {
	type group struct {
		kind, producer string
		items          []types.ResourceItem
	}
	var order []string
	groups := map[string]*group{}
	for _, item := range items {
		key := item.Kind + "\x00" + item.Producer
		g := groups[key]
		if g == nil {
			g = &group{kind: item.Kind, producer: item.Producer}
			groups[key] = g
			order = append(order, key)
		}
		g.items = append(g.items, item)
	}

	var out []ItemImport
	for _, key := range order {
		g := groups[key]
		fields := map[string]any{"kind": g.kind, "producer": g.producer, "count": len(g.items)}
		outcome := func(o, reason string) {
			for _, item := range g.items {
				out = append(out, ItemImport{Kind: g.kind, Producer: g.producer, ID: item.ID, Outcome: o, Reason: reason})
			}
		}
		b.mu.RLock()
		entry := b.producers[g.kind][g.producer]
		b.mu.RUnlock()
		if entry == nil {
			utils.LogWithFields(utils.LevelWarn, "resource", "import: no such producer here", fields)
			outcome("no_producer", "no producer "+g.producer+" for kind "+g.kind)
			continue
		}
		handlers := entry.transferHandlers()
		if handlers.Import == nil {
			utils.LogWithFields(utils.LevelWarn, "resource", "import: producer cannot import", fields)
			outcome("unsupported", "producer "+g.producer+" cannot import")
			continue
		}
		result, err := handlers.Import(g.items)
		if errors.Is(err, ErrTransferUnsupported) {
			utils.LogWithFields(utils.LevelWarn, "resource", "import: producer cannot import", fields)
			outcome("unsupported", "producer "+g.producer+" cannot import")
			continue
		}
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "resource", "import: producer failed", mergeLogFields(fields, map[string]any{"error": err.Error()}))
			outcome("failed", err.Error())
			continue
		}
		accepted := map[string]bool{}
		for _, id := range result.Accepted {
			accepted[id] = true
		}
		refused := map[string]string{}
		for _, r := range result.Refused {
			refused[r.ID] = r.Reason
		}
		for _, item := range g.items {
			switch {
			case accepted[item.ID]:
				out = append(out, ItemImport{Kind: g.kind, Producer: g.producer, ID: item.ID, Outcome: "accepted"})
			default:
				reason := refused[item.ID]
				if reason == "" {
					reason = "producer did not accept the item"
				}
				out = append(out, ItemImport{Kind: g.kind, Producer: g.producer, ID: item.ID, Outcome: "refused", Reason: reason})
			}
		}
		utils.LogWithFields(utils.LevelInfo, "resource", "import: producer answered", mergeLogFields(fields, map[string]any{"accepted": len(result.Accepted), "refused": len(g.items) - len(result.Accepted)}))
	}
	return out
}

// ForgetConversations tells every producer to drop its items for the given
// conversations. A producer without a forget handler is reported, not failed.
func (b *Broker) ForgetConversations(conversationIDs []string) []ProducerForget {
	var out []ProducerForget
	for _, entry := range b.sortedEntries() {
		fields := map[string]any{"kind": entry.kind, "producer": entry.producer, "count": len(conversationIDs)}
		result := ProducerForget{Kind: entry.kind, Producer: entry.producer}
		handlers := entry.transferHandlers()
		if handlers.Forget == nil {
			result.Outcome = "unsupported"
			out = append(out, result)
			continue
		}
		removed, err := handlers.Forget(conversationIDs)
		switch {
		case errors.Is(err, ErrTransferUnsupported):
			result.Outcome = "unsupported"
		case err != nil:
			result.Outcome = "failed"
			result.Error = err.Error()
			utils.LogWithFields(utils.LevelWarn, "resource", "forget: producer failed", mergeLogFields(fields, map[string]any{"error": err.Error()}))
		default:
			result.Outcome = "forgotten"
			result.Removed = removed
			utils.LogWithFields(utils.LevelInfo, "resource", "forget: producer answered", mergeLogFields(fields, map[string]any{"removed": removed}))
		}
		out = append(out, result)
	}
	return out
}

func mergeLogFields(a, b map[string]any) map[string]any {
	out := make(map[string]any, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}
