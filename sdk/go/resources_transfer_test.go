package ion

import (
	"context"
	"testing"
)

// resources_transfer_test.go — resource/export, resource/import,
// resource/forget. Pinned: each reaches the kind's handler with the engine's
// arguments and answers the shape the engine decodes, and a kind with no
// handler answers CodeMethodNotFound, which the engine reads as "cannot".

func TestResourceTransferRoundTrip(t *testing.T) {
	fe := newFakeEngine(t, WithName("resource-transfer-test"))
	store := map[string]ResourceItem{"r1": {ID: "r1", Kind: "report", ConversationID: "conv-a", Content: "body"}}
	api := fe.sdk.Resources()
	api.OnExport("report", func(c context.Context, ids []string) ([]ResourceItem, error) {
		var out []ResourceItem
		for _, item := range store {
			for _, id := range ids {
				if item.ConversationID == id {
					out = append(out, item)
				}
			}
		}
		return out, nil
	})
	api.OnImport("report", func(c context.Context, items []ResourceItem) (ResourceImportResult, error) {
		var result ResourceImportResult
		for _, item := range items {
			if _, exists := store[item.ID]; exists {
				result.Refused = append(result.Refused, ResourceImportRefusal{ID: item.ID, Reason: "exists"})
				continue
			}
			store[item.ID] = item
			result.Accepted = append(result.Accepted, item.ID)
		}
		return result, nil
	})
	api.OnForget("report", func(c context.Context, ids []string) (int, error) {
		removed := 0
		for key, item := range store {
			for _, id := range ids {
				if item.ConversationID == id {
					delete(store, key)
					removed++
				}
			}
		}
		return removed, nil
	})
	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(200, methodResourceExport, map[string]any{"kind": "report", "conversationIds": []string{"conv-a"}})
	exported, ok := fe.awaitResponse(200)["result"].([]any)
	if !ok || len(exported) != 1 {
		t.Fatalf("export result = %+v", exported)
	}

	fe.request(201, methodResourceImport, map[string]any{"kind": "report", "items": []map[string]any{
		{"id": "r2", "kind": "report", "conversationId": "conv-a", "content": "new", "createdAt": "2026-09-23T00:00:00Z"},
		{"id": "r1", "kind": "report", "conversationId": "conv-a", "content": "dup", "createdAt": "2026-09-23T00:00:00Z"},
	}})
	imported, _ := fe.awaitResponse(201)["result"].(map[string]any)
	if accepted, _ := imported["accepted"].([]any); len(accepted) != 1 || accepted[0] != "r2" {
		t.Fatalf("import accepted = %+v", imported)
	}
	if refused, _ := imported["refused"].([]any); len(refused) != 1 {
		t.Fatalf("import refused = %+v", imported)
	}

	fe.request(202, methodResourceForget, map[string]any{"kind": "report", "conversationIds": []string{"conv-a"}})
	forgot, _ := fe.awaitResponse(202)["result"].(map[string]any)
	if removed, _ := forgot["removed"].(float64); removed != 2 || len(store) != 0 {
		t.Fatalf("forget = %+v, store = %+v", forgot, store)
	}
}

func TestResourceTransferWithoutHandlerIsMethodNotFound(t *testing.T) {
	fe := newFakeEngine(t, WithName("resource-transfer-none"))
	fe.start()
	fe.doInit(ExtensionConfig{})
	for i, method := range []string{methodResourceExport, methodResourceImport, methodResourceForget} {
		id := int64(300 + i)
		fe.request(id, method, map[string]any{"kind": "report"})
		errObj, _ := fe.awaitResponse(id)["error"].(map[string]any)
		if code, _ := errObj["code"].(float64); int(code) != CodeMethodNotFound {
			t.Errorf("%s: error = %+v, want code %d", method, errObj, CodeMethodNotFound)
		}
	}
}
