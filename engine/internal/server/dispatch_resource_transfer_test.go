package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/types"
)

// resultData finds the result frame for requestID and decodes its data.
func resultData(t *testing.T, lines []string, requestID string, into any) {
	t.Helper()
	for _, l := range lines {
		if !strings.Contains(l, requestID) {
			continue
		}
		var frame struct {
			OK   bool            `json:"ok"`
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal([]byte(l), &frame); err != nil || frame.Data == nil {
			continue
		}
		if !frame.OK {
			t.Fatalf("%s failed: %s", requestID, l)
		}
		if err := json.Unmarshal(frame.Data, into); err != nil {
			t.Fatalf("decode %s: %v", requestID, err)
		}
		return
	}
	t.Fatalf("no result for %s; lines=%v", requestID, lines)
}

// The three transfer commands route through the session broker named by key
// and return each producer's answer over the wire.
func TestDispatchResourceTransfer_ExportImportForget(t *testing.T) {
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	defer conn.Close()
	startSession(t, conn, "rt-session", "req-rt-start")

	broker := srv.manager.ResourceBroker("rt-session")
	store := []types.ResourceItem{{ID: "r1", ConversationID: "conv-a", Content: "body"}}
	host := &resource.FuncProducerHost{}
	if err := broker.RegisterProducerFor("report", "cos2", host, types.ResourceDeclaration{Kind: "report"}); err != nil {
		t.Fatal(err)
	}
	var imported []types.ResourceItem
	forgotten := 0
	broker.SetTransferHandlersFor("report", "cos2", resource.TransferHandlers{
		Export: func([]string) ([]types.ResourceItem, error) { return store, nil },
		Import: func(items []types.ResourceItem) (resource.ImportResult, error) {
			imported = append(imported, items...)
			return resource.ImportResult{Accepted: []string{items[0].ID}}, nil
		},
		Forget: func(ids []string) (int, error) { forgotten = len(ids); return 1, nil },
	})

	sendJSON(t, conn, map[string]any{"cmd": "resource_export", "key": "rt-session", "resourceConversationIds": []string{"conv-a"}, "requestId": "req-rt-export"})
	var exported struct {
		Producers []resource.ProducerExport `json:"producers"`
	}
	resultData(t, readLines(t, conn, 6, 3*time.Second), "req-rt-export", &exported)
	if len(exported.Producers) != 1 || len(exported.Producers[0].Items) != 1 || exported.Producers[0].Items[0].Producer != "cos2" {
		t.Fatalf("export = %+v", exported)
	}

	sendJSON(t, conn, map[string]any{"cmd": "resource_import", "key": "rt-session", "resourceItems": exported.Producers[0].Items, "requestId": "req-rt-import"})
	var importResult struct {
		Items []resource.ItemImport `json:"items"`
	}
	resultData(t, readLines(t, conn, 6, 3*time.Second), "req-rt-import", &importResult)
	if len(importResult.Items) != 1 || importResult.Items[0].Outcome != "accepted" || len(imported) != 1 {
		t.Fatalf("import = %+v", importResult)
	}

	sendJSON(t, conn, map[string]any{"cmd": "resource_forget", "key": "rt-session", "resourceConversationIds": []string{"conv-a"}, "requestId": "req-rt-forget"})
	var forgetResult struct {
		Producers []resource.ProducerForget `json:"producers"`
	}
	resultData(t, readLines(t, conn, 6, 3*time.Second), "req-rt-forget", &forgetResult)
	if len(forgetResult.Producers) != 1 || forgetResult.Producers[0].Outcome != "forgotten" || forgotten != 1 {
		t.Fatalf("forget = %+v", forgetResult)
	}
}
