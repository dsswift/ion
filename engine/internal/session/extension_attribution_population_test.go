package session

// Population-path coverage for extension telemetry attribution.
//
// The pre-existing attribution tests (manager_extension_attribution_test.go,
// backend/runloop_telemetry_test.go, extcontext/dispatch_agent_span_test.go)
// pin EMISSION only: they set s.extensionName / s.extensionVersion directly on
// the session struct and assert the telemetry context carries the values. None
// of them exercise POPULATION — how s.extensionName gets set in a real
// extension-hosted session.
//
// That gap shipped a production bug: the only population site was the
// engine_status broadcast handler inside SetPersistentEmit
// (start_session.go), but ext/emit prefers the ACTIVE hook context's Emit
// (host_rpc.go) over persistentEmit. Extensions broadcast engine_status from
// inside hooks (session_start / before_prompt — the normal case), so the
// persistent handler never saw the name and ctx.extension was NULL on every
// run.complete and llm.call in production.
//
// This test drives the REAL lifecycle: StartSession with config.Extensions
// pointing at a real node subprocess whose init handshake carries the name
// (and no extension.json manifest — mirroring ~/.ion/extensions/ion-dev),
// then asserts:
//  1. RunOptions handed to the backend carry ExtensionName (llm.call path),
//  2. run.complete telemetry context carries "extension",
//  3. "extension_version" is ABSENT (no manifest → omit-when-absent).
//
// RED on unfixed population: with the host-name capture in
// loadAndWireExtensions reverted, s.extensionName stays "" (the subprocess
// never emits engine_status through the persistent path), so both assertions
// 1 and 2 fail.

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// writePopulationExt writes a minimal manifest-less extension that answers the
// init handshake with a name and every other request with a null result (so
// hook fires like session_start / before_agent_start return promptly instead
// of timing out). It never emits engine_status — matching an extension that
// only broadcasts from inside hook contexts, the case that broke production.
func writePopulationExt(t *testing.T, dir string) string {
	t.Helper()
	src := `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'init') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { name: 'population-ext' } }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }) + '\n');
  }
});
setInterval(() => {}, 1000);
`
	jsPath := filepath.Join(dir, "population-ext.js")
	if err := os.WriteFile(jsPath, []byte(src), 0o644); err != nil {
		t.Fatalf("write tmp ext: %v", err)
	}
	return jsPath
}

func TestExtensionAttribution_PopulationPath_RealLifecycle(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	dir := t.TempDir()
	jsPath := writePopulationExt(t, dir)

	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()

	cfg := defaultConfig()
	cfg.WorkingDirectory = dir
	cfg.Extensions = []string{jsPath}

	done := make(chan error, 1)
	go func() {
		_, err := mgr.StartSession("pop-attr", cfg)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("StartSession failed: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("StartSession timed out")
	}

	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	mgr.mu.Lock()
	s := mgr.sessions["pop-attr"]
	s.telemetry = collector
	s.lastModel = "claude-sonnet-4-6"
	s.conversationID = "conv-pop-attr"
	mgr.mu.Unlock()

	// (1) llm.call path: the RunOptions handed to the backend must carry the
	// extension identity captured from the init handshake at load time.
	if err := mgr.SendPrompt("pop-attr", "hello", nil); err != nil {
		t.Fatalf("SendPrompt failed: %v", err)
	}
	mb.mu.Lock()
	if len(mb.startOrder) != 1 {
		mb.mu.Unlock()
		t.Fatalf("expected 1 started run, got %d", len(mb.startOrder))
	}
	requestID := mb.startOrder[0]
	opts := mb.started[requestID]
	mb.mu.Unlock()
	if opts.ExtensionName != "population-ext" {
		t.Errorf("RunOptions.ExtensionName = %q, want %q (population path broken: session never captured host name)", opts.ExtensionName, "population-ext")
	}
	if opts.ExtensionVersion != "" {
		t.Errorf("RunOptions.ExtensionVersion = %q, want empty (no extension.json manifest)", opts.ExtensionVersion)
	}

	// (2) run.complete path: drive the run to completion through the real
	// normalized-event pipeline and assert the telemetry context.
	mgr.handleNormalizedEvent(requestID, types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			Result:     "done",
			CostUsd:    0.02,
			DurationMs: 500,
			NumTurns:   1,
			Usage:      types.UsageData{InputTokens: intPtr(10), OutputTokens: intPtr(5)},
		},
	})

	events := drainTelemetry(t, collector)
	runComplete := filterByName(events, telemetry.RunComplete)
	if len(runComplete) != 1 {
		t.Fatalf("expected 1 run.complete event, got %d", len(runComplete))
	}
	e := runComplete[0]
	assertCtxStr(t, e.Context, "extension", "population-ext")
	// (3) No manifest → no version. Omit-when-absent must hold so dashboards
	// don't get a spurious empty-string label.
	if _, ok := e.Context["extension_version"]; ok {
		t.Errorf("run.complete context carries extension_version %v, want absent (no manifest)", e.Context["extension_version"])
	}
}
