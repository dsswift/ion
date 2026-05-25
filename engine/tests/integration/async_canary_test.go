//go:build integration

// Async-trigger integration tests. Loads the async-canary extension
// through a real subprocess (esbuild transpile + node), then verifies:
//
//   1. Static webhook + schedule registrations declared at module
//      scope arrive in the host's asyncreg registry after Load.
//   2. The lifecycle hooks (webhook_registered / schedule_registered)
//      fire at init with origin="init".
//   3. host.FireAsync dispatches a webhook fire and returns the
//      handler's response. Crucially, the SDK runtime's incoming
//      engine/fire_async handler runs with a ctx that has
//      dispatchAgent / sendPrompt / emit wired — this is the
//      closure of #132 inside CI.
//   4. Dynamic registration from inside a tool call adds to the
//      registry and is visible to subsequent FireAsync calls.
//   5. The veto pipeline blocks a registration when a
//      webhook_registered hook returns {block: true}.

package integration

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
)

// asyncCanaryEntry resolves the absolute path of the async-canary
// extension's entry point. Mirrors ionCanaryEntry / ionMetaEntry.
func asyncCanaryEntry(t *testing.T) string {
	t.Helper()
	repoDir := filepath.Join("..", "..", "extensions", "async-canary")
	abs, err := filepath.Abs(filepath.Join(repoDir, "index.ts"))
	if err != nil {
		t.Fatalf("resolve async-canary path: %v", err)
	}
	return abs
}

// loadAsyncCanary loads the extension into a fresh host and returns
// it. The host's Dispose is registered with t.Cleanup so leaks are
// caught by go test's cleanup pass.
func loadAsyncCanary(t *testing.T) *extension.Host {
	t.Helper()
	requireEsbuild(t)
	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	entry := asyncCanaryEntry(t)
	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     filepath.Dir(entry),
		WorkingDirectory: t.TempDir(),
	}); err != nil {
		t.Fatalf("load async-canary: %v", err)
	}
	return host
}

// Test 1: static init registrations land in the registry.
func TestAsyncCanary_StaticInitRegistrations(t *testing.T) {
	host := loadAsyncCanary(t)
	// CommitPendingAsyncDecls is normally called by the session
	// manager; in this integration test we drive it manually since
	// we're loading the host directly. Future iteration: wrap into
	// a test-helper Manager.
	errs := host.CommitPendingAsyncDecls()
	if len(errs) != 0 {
		t.Fatalf("init commit errors: %v", errs)
	}

	webhooks := host.Webhooks()
	if len(webhooks) != 1 {
		t.Fatalf("expected 1 webhook, got %d: %+v", len(webhooks), webhooks)
	}
	if webhooks[0].Path != "/test/hello" {
		t.Fatalf("webhook path = %q, want /test/hello", webhooks[0].Path)
	}
	if webhooks[0].Auth.Kind != extension.AuthBearer {
		t.Fatalf("webhook auth kind = %q, want bearer", webhooks[0].Auth.Kind)
	}

	schedules := host.Schedules()
	if len(schedules) != 1 {
		t.Fatalf("expected 1 schedule, got %d", len(schedules))
	}
	if schedules[0].JobID != "async-canary-tick" {
		t.Fatalf("schedule id = %q, want async-canary-tick", schedules[0].JobID)
	}
	if schedules[0].Kind != extension.ScheduleInterval {
		t.Fatalf("schedule kind = %q, want interval", schedules[0].Kind)
	}
}

// Test 2: lifecycle hooks fire at init with origin=init.
func TestAsyncCanary_LifecycleHooksFireAtInit(t *testing.T) {
	host := loadAsyncCanary(t)
	// Capture lifecycle calls by replacing the host's onLifecycleHook
	// before commit. The async-canary's own webhook_registered hook
	// will also fire — that's fine; we just want to see our own
	// capture run at least once.
	var seen []extension.AsyncRegistrationInfo
	host.SetOnLifecycleHook(func(event string, info extension.AsyncRegistrationInfo) error {
		// Only record *_registered events so the count is stable.
		if event == extension.HookWebhookRegistered || event == extension.HookScheduleRegistered {
			seen = append(seen, info)
		}
		return nil
	})
	if errs := host.CommitPendingAsyncDecls(); len(errs) != 0 {
		t.Fatalf("commit errors: %v", errs)
	}
	if len(seen) != 2 {
		t.Fatalf("expected 2 lifecycle fires, got %d: %+v", len(seen), seen)
	}
	for _, info := range seen {
		if info.Origin != string(asyncreg.OriginInit) {
			t.Errorf("expected origin=init, got %q for %s", info.Origin, info.ID)
		}
	}
}

// Test 3: FireAsync dispatches a webhook fire and returns the
// handler's typed response. The handler echoes a JSON body so we can
// assert both the round-trip and the freshly-built ctx side of the
// dispatch.
func TestAsyncCanary_WebhookFireRoundTrip(t *testing.T) {
	host := loadAsyncCanary(t)
	if errs := host.CommitPendingAsyncDecls(); len(errs) != 0 {
		t.Fatalf("commit errors: %v", errs)
	}

	// Construct a synthetic request payload mirroring what the engine's
	// HTTP server would send.
	payload := map[string]interface{}{
		"method":  "POST",
		"path":    "/test/hello",
		"url":     "/test/hello",
		"query":   "",
		"headers": map[string]string{"Authorization": "Bearer test-secret", "Content-Type": "application/json"},
		"body":    `{"name":"integration"}`,
		"remote":  "127.0.0.1:12345",
	}

	ctx := &extension.Context{SessionKey: "test-session"}
	raw, err := host.FireAsync(asyncreg.KindWebhook, "/test/hello", ctx, payload, 5*time.Second)
	if err != nil {
		t.Fatalf("FireAsync failed: %v", err)
	}
	var resp struct {
		Status  int               `json:"status"`
		Body    string            `json:"body"`
		Headers map[string]string `json:"headers"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("parse response: %v (raw=%s)", err, string(raw))
	}
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200", resp.Status)
	}
	if !strings.Contains(resp.Body, `"greeted":"integration"`) {
		t.Fatalf("body did not contain greeting: %q", resp.Body)
	}
	if resp.Headers["X-Async-Canary"] != "ok" {
		t.Errorf("expected X-Async-Canary=ok, got headers=%+v", resp.Headers)
	}
}

// Test 4: dynamic registration from inside a tool call adds to the
// registry and the new route fires via FireAsync.
func TestAsyncCanary_DynamicWebhookRegistration(t *testing.T) {
	host := loadAsyncCanary(t)
	if errs := host.CommitPendingAsyncDecls(); len(errs) != 0 {
		t.Fatalf("commit errors: %v", errs)
	}

	// Invoke the canary tool that does a runtime register.
	tool := findTool(t, host, "async_canary_register_dynamic_webhook")
	ctx := &extension.Context{SessionKey: "test-session"}
	result, err := tool.Execute(map[string]any{}, ctx)
	if err != nil {
		t.Fatalf("tool exec failed: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("tool reported failure: %+v", result)
	}

	// /test/dynamic should now appear in the registry.
	webhooks := host.Webhooks()
	foundDynamic := false
	for _, w := range webhooks {
		if w.Path == "/test/dynamic" {
			foundDynamic = true
		}
	}
	if !foundDynamic {
		t.Fatalf("dynamic route not in registry: %+v", webhooks)
	}

	// And the dynamically-registered handler must fire successfully.
	payload := map[string]interface{}{
		"method":  "POST",
		"path":    "/test/dynamic",
		"headers": map[string]string{},
		"body":    "",
	}
	raw, err := host.FireAsync(asyncreg.KindWebhook, "/test/dynamic", ctx, payload, 5*time.Second)
	if err != nil {
		t.Fatalf("FireAsync dynamic: %v", err)
	}
	var resp struct {
		Status int    `json:"status"`
		Body   string `json:"body"`
	}
	_ = json.Unmarshal(raw, &resp)
	if resp.Status != 200 || resp.Body != "dynamic" {
		t.Fatalf("dynamic handler returned status=%d body=%q (raw=%s)", resp.Status, resp.Body, string(raw))
	}
}

// Test 5: veto via the webhook_registered hook prevents registration
// and surfaces the reason verbatim to the caller.
func TestAsyncCanary_RegistrationVeto(t *testing.T) {
	host := loadAsyncCanary(t)
	if errs := host.CommitPendingAsyncDecls(); len(errs) != 0 {
		t.Fatalf("commit errors: %v", errs)
	}

	// Install the blocker hook via the canary's helper tool.
	installer := findTool(t, host, "async_canary_install_blocker")
	ctx := &extension.Context{SessionKey: "test-session"}
	if _, err := installer.Execute(map[string]any{}, ctx); err != nil {
		t.Fatalf("install blocker: %v", err)
	}

	// We need to wire the host's lifecycle-hook callback so the
	// registry's veto pipeline actually fires the SDK hook. In a real
	// session this is done by Manager.wireHostAsync; here we wire it
	// manually for the test. Build a non-nil ctx so the hook forwarder
	// (which sends the call into the subprocess) can populate the
	// `_ctx` field of the hook payload.
	hookCtx := &extension.Context{SessionKey: "test-session"}
	host.SetOnLifecycleHook(func(event string, info extension.AsyncRegistrationInfo) error {
		switch event {
		case extension.HookWebhookRegistered:
			return host.SDK().FireWebhookRegistered(hookCtx, info)
		case extension.HookScheduleRegistered:
			return host.SDK().FireScheduleRegistered(hookCtx, info)
		}
		return nil
	})

	// Trigger the canary's blocked-register tool. It should report a
	// blocked-by-policy error rather than success.
	attempt := findTool(t, host, "async_canary_attempt_blocked_register")
	result, err := attempt.Execute(map[string]any{}, ctx)
	if err != nil {
		t.Fatalf("attempt tool exec failed: %v", err)
	}
	if result == nil {
		t.Fatal("attempt tool returned nil result")
	}
	if !strings.Contains(result.Content, "blocked") {
		t.Fatalf("expected blocked reason in result, got: %q", result.Content)
	}

	// Sanity: the blocked path must NOT be in the registry.
	for _, w := range host.Webhooks() {
		if strings.Contains(w.Path, "blocked") {
			t.Fatalf("blocked path leaked into registry: %q", w.Path)
		}
	}
}
