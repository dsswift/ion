package resource

import (
	"errors"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// memoryProducer is a producer with a real store behind its transfer handlers.
type memoryProducer struct {
	items []types.ResourceItem
}

func (m *memoryProducer) query(filter types.ResourceFilter) ([]types.ResourceItem, error) {
	var out []types.ResourceItem
	for _, item := range m.items {
		if filter.ConversationID == "" || item.ConversationID == filter.ConversationID {
			out = append(out, item)
		}
	}
	return out, nil
}

func (m *memoryProducer) handlers() TransferHandlers {
	return TransferHandlers{
		Export: func(ids []string) ([]types.ResourceItem, error) {
			var out []types.ResourceItem
			for _, id := range ids {
				got, _ := m.query(types.ResourceFilter{ConversationID: id}) //nolint:errcheck // memory query never fails
				out = append(out, got...)
			}
			return out, nil
		},
		Import: func(items []types.ResourceItem) (ImportResult, error) {
			var result ImportResult
			for _, item := range items {
				if item.Content == "" {
					result.Refused = append(result.Refused, ImportRefusal{ID: item.ID, Reason: "no content"})
					continue
				}
				m.items = append(m.items, item)
				result.Accepted = append(result.Accepted, item.ID)
			}
			return result, nil
		},
		Forget: func(ids []string) (int, error) {
			drop := map[string]bool{}
			for _, id := range ids {
				drop[id] = true
			}
			kept := m.items[:0]
			removed := 0
			for _, item := range m.items {
				if drop[item.ConversationID] {
					removed++
					continue
				}
				kept = append(kept, item)
			}
			m.items = kept
			return removed, nil
		},
	}
}

func registerMemory(t *testing.T, b *Broker, kind, producer string, m *memoryProducer, withTransfer bool) {
	t.Helper()
	host := &FuncProducerHost{}
	if err := b.RegisterProducerFor(kind, producer, host, types.ResourceDeclaration{Kind: kind}); err != nil {
		t.Fatal(err)
	}
	b.SetQueryHandlerFor(kind, producer, m.query)
	if withTransfer {
		b.SetTransferHandlersFor(kind, producer, m.handlers())
	}
}

// A conversation's items move from one broker's producer to the same-named
// producer on another, and the first producer then forgets them.
func TestTransfer_ExportImportForgetRoundTrip(t *testing.T) {
	source := &memoryProducer{items: []types.ResourceItem{
		{ID: "r1", ConversationID: "conv-a", Content: "report a"},
		{ID: "r2", ConversationID: "conv-b", Content: "report b"},
	}}
	src := NewBroker()
	registerMemory(t, src, "report", "cos2", source, true)

	exports := src.ExportConversations([]string{"conv-a"})
	if len(exports) != 1 || !exports[0].ExportSupported || len(exports[0].Items) != 1 {
		t.Fatalf("export = %+v", exports)
	}
	if got := exports[0].Items[0]; got.Kind != "report" || got.Producer != "cos2" || got.Content != "report a" {
		t.Fatalf("exported item = %+v", got)
	}

	dest := &memoryProducer{}
	dst := NewBroker()
	registerMemory(t, dst, "report", "cos2", dest, true)
	outcomes := dst.ImportItems(exports[0].Items)
	if len(outcomes) != 1 || outcomes[0].Outcome != "accepted" || len(dest.items) != 1 {
		t.Fatalf("import = %+v, dest = %+v", outcomes, dest.items)
	}

	forgets := src.ForgetConversations([]string{"conv-a"})
	if len(forgets) != 1 || forgets[0].Outcome != "forgotten" || forgets[0].Removed != 1 {
		t.Fatalf("forget = %+v", forgets)
	}
	if len(source.items) != 1 || source.items[0].ID != "r2" {
		t.Fatalf("source kept %+v", source.items)
	}
}

// A producer with no export handler is read through its query handler,
// keeping only the requested conversations' items.
func TestTransfer_ExportFallsBackToQuery(t *testing.T) {
	m := &memoryProducer{items: []types.ResourceItem{
		{ID: "r1", ConversationID: "conv-a", Content: "a"},
		{ID: "r2", ConversationID: "conv-b", Content: "b"},
	}}
	b := NewBroker()
	registerMemory(t, b, "note", "plain", m, false)
	exports := b.ExportConversations([]string{"conv-a"})
	if len(exports) != 1 || exports[0].ExportSupported || len(exports[0].Items) != 1 || exports[0].Items[0].ID != "r1" {
		t.Fatalf("export = %+v", exports)
	}
}

func TestTransfer_ImportOutcomes(t *testing.T) {
	b := NewBroker()
	registerMemory(t, b, "report", "cos2", &memoryProducer{}, true)
	registerMemory(t, b, "note", "plain", &memoryProducer{}, false)
	host := &FuncProducerHost{}
	if err := b.RegisterProducerFor("broken", "bad", host, types.ResourceDeclaration{Kind: "broken"}); err != nil {
		t.Fatal(err)
	}
	b.SetTransferHandlersFor("broken", "bad", TransferHandlers{Import: func([]types.ResourceItem) (ImportResult, error) {
		return ImportResult{}, errors.New("disk full")
	}})

	outcomes := b.ImportItems([]types.ResourceItem{
		{ID: "ok", Kind: "report", Producer: "cos2", Content: "x"},
		{ID: "empty", Kind: "report", Producer: "cos2"},
		{ID: "n1", Kind: "note", Producer: "plain", Content: "x"},
		{ID: "m1", Kind: "report", Producer: "missing", Content: "x"},
		{ID: "b1", Kind: "broken", Producer: "bad", Content: "x"},
	})
	want := map[string]string{"ok": "accepted", "empty": "refused", "n1": "unsupported", "m1": "no_producer", "b1": "failed"}
	if len(outcomes) != len(want) {
		t.Fatalf("outcomes = %+v", outcomes)
	}
	for _, o := range outcomes {
		if want[o.ID] != o.Outcome {
			t.Errorf("item %s outcome %q, want %q (%s)", o.ID, o.Outcome, want[o.ID], o.Reason)
		}
	}
}

func TestTransfer_ForgetUnsupportedIsReported(t *testing.T) {
	b := NewBroker()
	registerMemory(t, b, "note", "plain", &memoryProducer{}, false)
	b.SetTransferHandlersFor("note", "plain", TransferHandlers{Forget: func([]string) (int, error) { return 0, ErrTransferUnsupported }})
	forgets := b.ForgetConversations([]string{"conv-a"})
	if len(forgets) != 1 || forgets[0].Outcome != "unsupported" {
		t.Fatalf("forget = %+v", forgets)
	}
}
