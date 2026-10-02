package ion

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestNewContextDecodesConversationRecordPath(t *testing.T) {
	sdk := New()
	const path = "/data/conversations/conversation-1.tree.jsonl"
	ctx := sdk.newContext(json.RawMessage(`{"conversationId":"conversation-1","conversationRecordPath":"` + path + `"}`))
	if ctx.ConversationRecordPath != path {
		t.Errorf("ConversationRecordPath = %q, want %q", ctx.ConversationRecordPath, path)
	}

	// No conversation active: the engine omits the key, and the field is empty.
	if idle := sdk.newContext(json.RawMessage(`{"cwd":"/work"}`)); idle.ConversationRecordPath != "" {
		t.Errorf("ConversationRecordPath with no conversation = %q, want empty", idle.ConversationRecordPath)
	}
}

func TestConversationsReadSendsPagingAndDecodesRecord(t *testing.T) {
	fe := newFakeEngine(t, WithName("read-conversation-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	resultCh := make(chan *ConversationRecord, 1)
	errCh := make(chan error, 1)
	go func() {
		record, err := fe.sdk.newContext(nil).Conversations().Read(
			context.Background(), "conv-9", ReadConversationOpts{Offset: 3, Limit: 2})
		resultCh <- record
		errCh <- err
	}()

	frame := fe.awaitMethod("ext/read_conversation")
	id, ok := frame["id"].(float64)
	if !ok {
		t.Fatalf("request id = %#v", frame["id"])
	}
	params, ok := frame["params"].(map[string]any)
	if !ok {
		t.Fatalf("params = %#v", frame["params"])
	}
	if params["conversationId"] != "conv-9" || params["offset"] != float64(3) || params["limit"] != float64(2) {
		t.Errorf("params = %#v, want conversationId conv-9, offset 3, limit 2", params)
	}
	fe.respond(id, map[string]any{
		"messages": []map[string]any{
			{"id": "e1", "role": "user", "content": "hi", "timestamp": 1780093348767},
			{"id": "e2", "role": "tool", "content": "boom", "timestamp": 1780093349000, "toolName": "Bash", "isError": true},
		},
		"total":   9,
		"hasMore": true,
	})

	if err := <-errCh; err != nil {
		t.Fatalf("Conversations().Read: %v", err)
	}
	record := <-resultCh
	if record.Total != 9 || !record.HasMore || len(record.Messages) != 2 {
		t.Fatalf("record = %+v, want 2 messages, total 9, hasMore", record)
	}
	if m := record.Messages[0]; m.ID != "e1" || m.Role != "user" || m.Timestamp != 1780093348767 {
		t.Errorf("first message = %+v", m)
	}
	if m := record.Messages[1]; m.ToolName != "Bash" || !m.IsError {
		t.Errorf("second message = %+v", m)
	}
}

func TestConversationsReadSurfacesEngineError(t *testing.T) {
	fe := newFakeEngine(t, WithName("read-conversation-error-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	errCh := make(chan error, 1)
	go func() {
		_, err := fe.sdk.newContext(nil).Conversations().Read(context.Background(), "missing", ReadConversationOpts{})
		errCh <- err
	}()
	frame := fe.awaitMethod("ext/read_conversation")
	id, ok := frame["id"].(float64)
	if !ok {
		t.Fatalf("request id = %#v", frame["id"])
	}
	fe.respondError(id, -32000, "conversation not found: missing")
	if err := <-errCh; err == nil {
		t.Fatal("expected the engine's error, got nil")
	}
}

// engineTypesManifestPath is the engine's generated wire-type manifest,
// relative to this package.
const engineTypesManifestPath = "../../engine/internal/types/testdata/contracts.json"

// TestConversationMessageMatchesEngineRow pins the record row types to the
// engine's rows field for field, so a field the engine adds cannot be
// silently dropped by this SDK.
func TestConversationMessageMatchesEngineRow(t *testing.T) {
	data, err := os.ReadFile(filepath.Clean(engineTypesManifestPath))
	if err != nil {
		t.Fatalf("read engine types manifest at %s: %v", engineTypesManifestPath, err)
	}
	var manifest struct {
		Types map[string][]string `json:"sharedTypes"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatalf("decode engine types manifest: %v", err)
	}
	for engineType, sdkType := range map[string]reflect.Type{
		"SessionMessage":           reflect.TypeOf(ConversationMessage{}),
		"SessionMessageAttachment": reflect.TypeOf(ConversationMessageAttachment{}),
	} {
		want, ok := manifest.Types[engineType]
		if !ok {
			t.Errorf("engine manifest has no %s", engineType)
			continue
		}
		var got []string
		for i := 0; i < sdkType.NumField(); i++ {
			name, _, _ := strings.Cut(sdkType.Field(i).Tag.Get("json"), ",")
			got = append(got, name)
		}
		sort.Strings(got)
		sort.Strings(want)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s fields differ from engine %s\n sdk:    %v\n engine: %v", sdkType.Name(), engineType, got, want)
		}
	}
}
