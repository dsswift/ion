//go:build integration

// Respawn end-to-end: kill the canary subprocess, let the host respawn,
// and verify that:
//   1. The per-host asyncreg registry is wiped before re-commit
//   2. The new subprocess's init payload re-establishes the static
//      declarations (so /test/hello is reachable after respawn)
//   3. Dynamic registrations from the prior subprocess are NOT
//      restored (the extension is responsible for re-issuing them
//      in session_start, matching the agent-spec model)

package integration

import (
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
)

// TestRespawn_StaticDeclsRestoredDynamicDecsLost is the
// definitive respawn test. The flow:
//
//  1. Load the canary; static /test/hello + async-canary-tick land
//  2. Register a dynamic /test/dynamic + async-canary-dynamic via
//     the canary's tools
//  3. Kill the subprocess (SIGKILL)
//  4. Wait for the host to register dead
//  5. Manually Respawn (production: session manager does this from
//     handleHostDeath)
//  6. Call ResetAsyncRegistrations + CommitPendingAsyncDecls (the
//     same sequence host_death.go runs)
//  7. Assert: /test/hello is back, async-canary-tick is back,
//     /test/dynamic and async-canary-dynamic are NOT back
func TestRespawn_StaticDeclsRestoredDynamicDecsLost(t *testing.T) {
	requireEsbuild(t)
	t.Setenv("ASYNC_CANARY_TOKEN", "x")

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	entry := asyncCanaryEntry(t)
	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     filepath.Dir(entry),
		WorkingDirectory: t.TempDir(),
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if errs := host.CommitPendingAsyncDecls(); len(errs) != 0 {
		t.Fatalf("commit: %v", errs)
	}

	// Static decls present.
	if len(host.Webhooks()) != 1 {
		t.Fatalf("expected 1 static webhook pre-respawn, got %d", len(host.Webhooks()))
	}
	if got := scheduleJobIDs(host.Schedules()); !reflect.DeepEqual(got, asyncCanaryStaticScheduleIDs) {
		t.Fatalf("static schedules pre-respawn = %v, want %v", got, asyncCanaryStaticScheduleIDs)
	}

	// Add dynamic registrations.
	ctx := &extension.Context{SessionKey: "respawn-test"}
	if _, err := findTool(t, host, "async_canary_register_dynamic_webhook").Execute(map[string]any{}, ctx); err != nil {
		t.Fatalf("dyn webhook: %v", err)
	}
	if _, err := findTool(t, host, "async_canary_register_dynamic_schedule").Execute(map[string]any{}, ctx); err != nil {
		t.Fatalf("dyn schedule: %v", err)
	}
	// Now we should have 2 webhooks and 2 schedules.
	if len(host.Webhooks()) != 2 {
		t.Fatalf("expected 2 webhooks after dynamic, got %d: %+v", len(host.Webhooks()), host.Webhooks())
	}
	if want := len(asyncCanaryStaticScheduleIDs) + 1; len(host.Schedules()) != want {
		t.Fatalf("expected %d schedules after dynamic (%d static + 1 dynamic), got %d: %+v", want, len(asyncCanaryStaticScheduleIDs), len(host.Schedules()), host.Schedules())
	}

	// Kill the subprocess.
	if err := host.KillSubprocessForTest(); err != nil {
		t.Fatalf("kill: %v", err)
	}

	// Wait up to 3s for h.Dead() to flip true (the readLoop sets it
	// asynchronously after EOF).
	deadDeadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadDeadline) {
		if host.Dead() {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !host.Dead() {
		t.Fatal("host never registered as dead after kill")
	}

	// Now do what handleHostDeath does in production: reset the
	// stale registrations, respawn, re-commit init.
	host.ResetAsyncRegistrations()

	attempt, err := host.Respawn()
	if err != nil {
		t.Fatalf("Respawn: %v (attempt %d)", err, attempt)
	}
	if attempt < 1 {
		t.Fatalf("expected attempt >= 1, got %d", attempt)
	}

	// Re-commit the new subprocess's init payload.
	if errs := host.CommitPendingAsyncDecls(); len(errs) != 0 {
		t.Fatalf("post-respawn commit errors: %v", errs)
	}

	// Static decls back; dynamic decls NOT back.
	webhooks := host.Webhooks()
	if len(webhooks) != 1 {
		t.Fatalf("post-respawn webhook count = %d, want 1 (only static)", len(webhooks))
	}
	if webhooks[0].Path != "/test/hello" {
		t.Errorf("post-respawn webhook = %q, want /test/hello", webhooks[0].Path)
	}
	schedules := host.Schedules()
	if got := scheduleJobIDs(schedules); !reflect.DeepEqual(got, asyncCanaryStaticScheduleIDs) {
		t.Fatalf("post-respawn schedules = %v, want static only %v", got, asyncCanaryStaticScheduleIDs)
	}

	// Sanity: the dynamic path is genuinely gone from the registry,
	// not just absent from the slice ordering.
	if _, ok := host.AsyncRegistry().ByID(asyncreg.KindWebhook, "/test/dynamic"); ok {
		t.Error("/test/dynamic should not exist post-respawn")
	}
	if _, ok := host.AsyncRegistry().ByID(asyncreg.KindSchedule, "async-canary-dynamic"); ok {
		t.Error("async-canary-dynamic should not exist post-respawn")
	}

	// And the new subprocess actually responds to FireAsync — proves
	// the re-committed declaration is wired through to a live handler.
	payload := map[string]interface{}{
		"method":  "POST",
		"path":    "/test/hello",
		"headers": map[string]string{"Authorization": "Bearer x"},
		"body":    `{"name":"after-respawn"}`,
	}
	raw, err := host.FireAsync(asyncreg.KindWebhook, "/test/hello", ctx, payload, 5*time.Second)
	if err != nil {
		t.Fatalf("post-respawn FireAsync: %v", err)
	}
	if len(raw) == 0 {
		t.Fatal("post-respawn FireAsync returned empty body")
	}
}

// TestRespawn_DoubleResetIsSafe — calling ResetAsyncRegistrations on
// an already-empty registry must be a clean no-op. Important because
// the session manager's respawn flow always resets before commit,
// even if the prior subprocess never registered anything.
func TestRespawn_DoubleResetIsSafe(t *testing.T) {
	requireEsbuild(t)
	t.Setenv("ASYNC_CANARY_TOKEN", "x")

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	entry := asyncCanaryEntry(t)
	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     filepath.Dir(entry),
		WorkingDirectory: t.TempDir(),
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	// Reset before commit (nothing to reset).
	n := host.ResetAsyncRegistrations()
	if n != 0 {
		t.Fatalf("first reset removed %d entries on empty registry; want 0", n)
	}
	// Reset again, same result.
	n = host.ResetAsyncRegistrations()
	if n != 0 {
		t.Fatalf("second reset removed %d entries; want 0", n)
	}
}
