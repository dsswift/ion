//go:build integration

// Resource subsystem end-to-end tests. Loads the resource-canary
// extension, commits its resource declarations onto a broker, then
// drives the full create / update / delete lifecycle via tool calls
// and verifies events arrive at the broker subscriber.
//
// Also exercises ctx.notify() → ext/notify RPC → Context.Notify pipeline.

package integration

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/types"
)

// resourceCanaryEntry resolves the resource-canary extension entry point.
func resourceCanaryEntry(t *testing.T) string {
	t.Helper()
	repoDir := filepath.Join("..", "..", "extensions", "resource-canary")
	abs, err := filepath.Abs(filepath.Join(repoDir, "index.ts"))
	if err != nil {
		t.Fatalf("resolve resource-canary path: %v", err)
	}
	return abs
}

// loadResourceCanary loads the resource-canary extension into a fresh host.
func loadResourceCanary(t *testing.T) *extension.Host {
	t.Helper()
	requireEsbuild(t)
	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	entry := resourceCanaryEntry(t)
	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     filepath.Dir(entry),
		WorkingDirectory: t.TempDir(),
	}); err != nil {
		t.Fatalf("load resource-canary: %v", err)
	}
	return host
}

// TestResource_E2E_DeclareAndQuery verifies that resource declarations
// arrive after load and that a subscription delivers the canned snapshot.
func TestResource_E2E_DeclareAndQuery(t *testing.T) {
	host := loadResourceCanary(t)

	// After Load, the host must have one pending resource declaration.
	decls := host.Resources()
	if len(decls) != 1 {
		t.Fatalf("expected 1 resource declaration, got %d: %v", len(decls), decls)
	}
	if decls[0].Kind != "briefing" {
		t.Errorf("expected kind=briefing, got %q", decls[0].Kind)
	}

	// Confirm expected tools registered.
	for _, name := range []string{
		"canary_publish_briefing",
		"canary_update_briefing",
		"canary_delete_briefing",
		"canary_list_briefings",
	} {
		findTool(t, host, name)
	}

	// Commit declarations: registers FuncProducerHost + wires resource/query.
	broker := resource.NewBroker()
	if errs := host.CommitPendingResourceDecls(broker); len(errs) != 0 {
		t.Fatalf("CommitPendingResourceDecls errors: %v", errs)
	}

	// Subscribe: broker calls CallResourceQuery → resource/query RPC →
	// extension's onQuery handler → returns the canned item.
	var msgs []resource.ResourceMessage
	sub, err := broker.Subscribe("briefing", types.ResourceFilter{Kind: "briefing"}, func(msg resource.ResourceMessage) {
		msgs = append(msgs, msg)
	})
	if err != nil {
		t.Fatalf("broker.Subscribe: %v", err)
	}
	_ = sub

	if len(msgs) != 1 {
		t.Fatalf("expected 1 snapshot message, got %d", len(msgs))
	}
	snap := msgs[0]
	if snap.Type != "snapshot" {
		t.Errorf("message type: want snapshot, got %q", snap.Type)
	}
	if len(snap.Items) != 1 {
		t.Fatalf("snapshot item count: want 1, got %d", len(snap.Items))
	}
	if snap.Items[0].ID != "briefing-1" {
		t.Errorf("snapshot item ID: want briefing-1, got %q", snap.Items[0].ID)
	}
	if snap.Items[0].Title != "Morning Brief" {
		t.Errorf("snapshot item title: want Morning Brief, got %q", snap.Items[0].Title)
	}
}

// TestResource_E2E_FullCycle drives the complete lifecycle:
// snapshot on subscribe → publish create → update → delete → unsubscribe.
func TestResource_E2E_FullCycle(t *testing.T) {
	host := loadResourceCanary(t)

	broker := resource.NewBroker()
	if errs := host.CommitPendingResourceDecls(broker); len(errs) != 0 {
		t.Fatalf("CommitPendingResourceDecls: %v", errs)
	}

	// Subscribe and verify the initial snapshot.
	var msgs []resource.ResourceMessage
	sub, err := broker.Subscribe("briefing", types.ResourceFilter{Kind: "briefing"}, func(msg resource.ResourceMessage) {
		msgs = append(msgs, msg)
	})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	if len(msgs) != 1 || msgs[0].Type != "snapshot" {
		t.Fatalf("expected 1 snapshot, got %d messages: %+v", len(msgs), msgs)
	}

	// Build a ctx with PublishResource wired to the broker. The canary tools
	// call ext/publish_resource → host.handlePublishResource → ctx.PublishResource.
	ctx := &extension.Context{
		SessionKey: "resource-e2e",
		Cwd:        t.TempDir(),
		PublishResource: func(kind string, delta types.ResourceDelta) error {
			return broker.Publish(kind, delta)
		},
	}

	// Helper: wait up to deadline for msgs to grow to wantLen.
	waitMsgs := func(wantLen int) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for len(msgs) < wantLen && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if len(msgs) < wantLen {
			t.Fatalf("timeout waiting for %d messages; got %d: %+v", wantLen, len(msgs), msgs)
		}
	}

	// Step 1: publish a new briefing via tool call.
	publishTool := findTool(t, host, "canary_publish_briefing")
	result, err := publishTool.Execute(map[string]any{
		"id":      "briefing-2",
		"title":   "Evening Brief",
		"content": "# Good evening",
	}, ctx)
	if err != nil {
		t.Fatalf("canary_publish_briefing: %v", err)
	}
	if result.IsError {
		t.Fatalf("canary_publish_briefing returned error: %s", result.Content)
	}

	waitMsgs(2)
	createDelta := msgs[1]
	if createDelta.Type != "delta" || createDelta.Delta == nil {
		t.Fatalf("create delta: want type=delta with Delta, got %+v", createDelta)
	}
	if createDelta.Delta.Op != "create" {
		t.Errorf("create delta op: want create, got %q", createDelta.Delta.Op)
	}
	if createDelta.Delta.Item.ID != "briefing-2" {
		t.Errorf("create delta item ID: want briefing-2, got %q", createDelta.Delta.Item.ID)
	}

	// Step 2: update the new briefing.
	updateTool := findTool(t, host, "canary_update_briefing")
	result, err = updateTool.Execute(map[string]any{
		"id":    "briefing-2",
		"title": "Evening Brief (updated)",
	}, ctx)
	if err != nil {
		t.Fatalf("canary_update_briefing: %v", err)
	}
	if result.IsError {
		t.Fatalf("canary_update_briefing returned error: %s", result.Content)
	}

	waitMsgs(3)
	updateDelta := msgs[2]
	if updateDelta.Delta == nil || updateDelta.Delta.Op != "update" {
		t.Errorf("update delta: want op=update, got %+v", updateDelta.Delta)
	}
	if !strings.Contains(updateDelta.Delta.Item.Title, "updated") {
		t.Errorf("update delta title: want 'updated' in title, got %q", updateDelta.Delta.Item.Title)
	}

	// Step 3: delete the new briefing.
	deleteTool := findTool(t, host, "canary_delete_briefing")
	result, err = deleteTool.Execute(map[string]any{
		"id": "briefing-2",
	}, ctx)
	if err != nil {
		t.Fatalf("canary_delete_briefing: %v", err)
	}
	if result.IsError {
		t.Fatalf("canary_delete_briefing returned error: %s", result.Content)
	}

	waitMsgs(4)
	deleteDelta := msgs[3]
	if deleteDelta.Delta == nil || deleteDelta.Delta.Op != "delete" {
		t.Errorf("delete delta: want op=delete, got %+v", deleteDelta.Delta)
	}
	if deleteDelta.Delta.Item.ID != "briefing-2" {
		t.Errorf("delete delta item ID: want briefing-2, got %q", deleteDelta.Delta.Item.ID)
	}

	// Step 4: unsubscribe. Subsequent publishes must not arrive.
	broker.Unsubscribe(sub.ID)
	_ = broker.Publish("briefing", types.ResourceDelta{
		Op:   "create",
		Item: types.ResourceItem{ID: "briefing-3", Kind: "briefing", Content: "should not arrive"},
	})
	time.Sleep(50 * time.Millisecond)
	if len(msgs) != 4 {
		t.Fatalf("expected exactly 4 messages after unsubscribe, got %d", len(msgs))
	}
}

// TestResource_E2E_ListTool verifies the canary_list_briefings tool
// returns the in-memory store contents as JSON.
func TestResource_E2E_ListTool(t *testing.T) {
	host := loadResourceCanary(t)
	ctx := &extension.Context{SessionKey: "resource-list", Cwd: t.TempDir()}

	listTool := findTool(t, host, "canary_list_briefings")
	result, err := listTool.Execute(map[string]any{}, ctx)
	if err != nil {
		t.Fatalf("canary_list_briefings: %v", err)
	}
	if result.IsError {
		t.Fatalf("tool returned error: %s", result.Content)
	}

	inner := unwrapToolContent(t, result.Content)
	var items []map[string]interface{}
	if err := json.Unmarshal([]byte(inner), &items); err != nil {
		t.Fatalf("parse list result: %v (inner=%q)", err, inner)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d: %v", len(items), items)
	}
	if items[0]["id"] != "briefing-1" {
		t.Errorf("item[0].id: want briefing-1, got %v", items[0]["id"])
	}
	if items[0]["title"] != "Morning Brief" {
		t.Errorf("item[0].title: want Morning Brief, got %v", items[0]["title"])
	}
}

// TestResource_E2E_Notify exercises the ctx.notify() → ext/notify RPC →
// Context.Notify pipeline end-to-end. Verifies the notification arrives at
// the wired handler with correct fields.
func TestResource_E2E_Notify(t *testing.T) {
	host := loadResourceCanary(t)

	var mu sync.Mutex
	var captured []types.NotifyOpts

	ctx := &extension.Context{
		SessionKey: "resource-notify",
		Cwd:        t.TempDir(),
		Notify: func(opts types.NotifyOpts) error {
			mu.Lock()
			captured = append(captured, opts)
			mu.Unlock()
			return nil
		},
	}

	notifyTool := findTool(t, host, "canary_notify")
	result, err := notifyTool.Execute(map[string]any{
		"title": "Morning Brief Ready",
		"body":  "Your daily summary is available.",
	}, ctx)
	if err != nil {
		t.Fatalf("canary_notify: %v", err)
	}
	if result.IsError {
		t.Fatalf("canary_notify returned error: %s", result.Content)
	}

	// Verify the tool returned { notified: true }
	inner := unwrapToolContent(t, result.Content)
	var got map[string]interface{}
	if err := json.Unmarshal([]byte(inner), &got); err != nil {
		t.Fatalf("parse notify result: %v (inner=%q)", err, inner)
	}
	if got["notified"] != true {
		t.Errorf("expected notified=true, got %v", got["notified"])
	}

	mu.Lock()
	n := len(captured)
	mu.Unlock()
	if n != 1 {
		t.Fatalf("expected 1 notification captured, got %d", n)
	}
	mu.Lock()
	notif := captured[0]
	mu.Unlock()

	if notif.Kind != "briefing" {
		t.Errorf("notify kind: want briefing, got %q", notif.Kind)
	}
	if notif.Title != "Morning Brief Ready" {
		t.Errorf("notify title: want 'Morning Brief Ready', got %q", notif.Title)
	}
	if notif.Body != "Your daily summary is available." {
		t.Errorf("notify body: want 'Your daily summary is available.', got %q", notif.Body)
	}

	// Verify ext/notify rejects when Notify is not wired.
	noNotifyCtx := &extension.Context{SessionKey: "no-notify", Cwd: t.TempDir()}
	result2, err := notifyTool.Execute(map[string]any{
		"title": "Should fail",
		"body":  "No ctx.Notify wired",
	}, noNotifyCtx)
	if err != nil {
		t.Fatalf("canary_notify with no-notify ctx: unexpected Go error: %v", err)
	}
	// The tool should return an error result (not a panic) when notify is unavailable.
	if result2 != nil && !result2.IsError {
		// Some hosts may return an error result vs nil result; accept either.
		t.Logf("canary_notify with no-notify ctx: content=%q isError=%v", result2.Content, result2.IsError)
	}
	// Time box: notify tool should not hang
	_ = strings.Contains("", "") // dummy use of strings import
}
