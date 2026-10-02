package session

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestStartSession_ExtensionAllowlist_BlocksAndSurfaces pins the blocked-load
// path end to end. A blocked extension surfaces one engine_error with
// ErrorCode "extension_blocked" (never "extension_load_failed"), the Policy
// Failure identifier, and the blocked extension's identifier, and records an
// enforcement.extension_blocked audit event with the real reason.
//
// The text is the only thing policy messages change: the configured text
// replaces the engine default, and the code, the identifier, and the audit
// event are the same with and without it.
func TestStartSession_ExtensionAllowlist_BlocksAndSurfaces(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	const blockedText = "This extension is not approved. Request it through the software catalog."
	const wrongHash = "0000000000000000000000000000000000000000000000000000000000000000"
	cases := []struct {
		name       string
		allowlist  func(id string) []types.ExtensionAllowlistEntry
		messages   map[string]string
		wantReason string
		// wantText is the exact message; empty means the engine default,
		// which names the extension.
		wantText string
	}{
		{
			name: "not listed, default text",
			allowlist: func(string) []types.ExtensionAllowlistEntry {
				return []types.ExtensionAllowlistEntry{{ID: "only-this-one"}}
			},
			wantReason: "name",
		},
		{
			name: "not listed, configured text",
			allowlist: func(string) []types.ExtensionAllowlistEntry {
				return []types.ExtensionAllowlistEntry{{ID: "only-this-one"}}
			},
			messages:   map[string]string{types.PolicyFailureExtensionBlocked: blockedText},
			wantReason: "name",
			wantText:   blockedText,
		},
		{
			name: "hash mismatch, configured text",
			allowlist: func(id string) []types.ExtensionAllowlistEntry {
				return []types.ExtensionAllowlistEntry{{ID: id, SHA256: wrongHash}}
			},
			messages:   map[string]string{types.PolicyFailureExtensionBlocked: blockedText},
			wantReason: "hash",
			wantText:   blockedText,
		},
		{
			name: "blank configured text falls back to the default",
			allowlist: func(string) []types.ExtensionAllowlistEntry {
				return []types.ExtensionAllowlistEntry{{ID: "only-this-one"}}
			},
			messages:   map[string]string{types.PolicyFailureExtensionBlocked: ""},
			wantReason: "name",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			// No manifest, so the identifier is the directory basename.
			identifier := filepath.Base(dir)
			marker := filepath.Join(dir, "spawned")
			src := `
require('fs').writeFileSync(` + "`" + marker + "`" + `, '1');
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.method === 'init') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { name: 'blocked-ext' } }) + '\n');
  }
});
setInterval(() => {}, 1000);
`
			jsPath := filepath.Join(dir, "blocked-ext.js")
			if err := os.WriteFile(jsPath, []byte(src), 0o644); err != nil {
				t.Fatal(err)
			}

			mb := newMockBackend()
			mgr := NewManager(mb)
			defer mgr.Shutdown()

			var mu sync.Mutex
			var errs []types.EngineEvent
			mgr.OnEvent(func(_ string, ev types.EngineEvent) {
				if ev.Type == "engine_error" {
					mu.Lock()
					errs = append(errs, ev)
					mu.Unlock()
				}
			})

			cfg := defaultConfig()
			cfg.WorkingDirectory = dir
			cfg.Extensions = []string{jsPath}
			mgr.SetConfig(&types.EngineRuntimeConfig{
				Telemetry: &types.TelemetryConfig{Enabled: true, Targets: []string{}},
				Enterprise: &types.EnterpriseConfig{
					ExtensionAllowlist: tc.allowlist(identifier),
					Messages:           tc.messages,
				},
			})

			done := make(chan error, 1)
			go func() {
				_, err := mgr.StartSession("block1", cfg)
				done <- err
			}()
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("StartSession failed: %v", err)
				}
			case <-time.After(30 * time.Second):
				t.Fatal("StartSession timed out")
			}

			mu.Lock()
			defer mu.Unlock()
			if len(errs) != 1 {
				t.Fatalf("expected one engine_error, got %d: %+v", len(errs), errs)
			}
			ev := errs[0]
			if ev.ErrorCode != "extension_blocked" {
				t.Errorf("ErrorCode = %q, want extension_blocked", ev.ErrorCode)
			}
			if ev.PolicyFailure != types.PolicyFailureExtensionBlocked {
				t.Errorf("PolicyFailure = %q, want %q", ev.PolicyFailure, types.PolicyFailureExtensionBlocked)
			}
			if ev.ExtensionName != identifier {
				t.Errorf("ExtensionName = %q, want the blocked identifier %q", ev.ExtensionName, identifier)
			}
			if tc.wantText != "" {
				if ev.EventMessage != tc.wantText {
					t.Errorf("message = %q, want the configured text %q", ev.EventMessage, tc.wantText)
				}
			} else if !strings.HasPrefix(ev.EventMessage, "extension load failed: extension blocked by enterprise allowlist: ") || !strings.Contains(ev.EventMessage, identifier) {
				t.Errorf("message = %q, want the engine default naming %q", ev.EventMessage, identifier)
			}

			// The text never decides the load: the extension process never ran.
			if _, err := os.Stat(marker); err == nil {
				t.Error("blocked extension was spawned")
			}

			// The audit event records the real reason and identifier, whatever
			// text was shown.
			mgr.mu.Lock()
			collector := mgr.sessions["block1"].telemetry
			mgr.mu.Unlock()
			var audits []map[string]any
			for _, te := range collector.BufferedEvents() {
				if te.Name == telemetry.EnforcementExtensionBlocked {
					audits = append(audits, te.Payload)
				}
			}
			if len(audits) != 1 {
				t.Fatalf("expected one %s event, got %d", telemetry.EnforcementExtensionBlocked, len(audits))
			}
			if audits[0]["reason"] != tc.wantReason || audits[0]["subject"] != identifier || audits[0]["source"] != "allowlist" {
				t.Errorf("audit payload = %v, want reason %q subject %q source allowlist", audits[0], tc.wantReason, identifier)
			}
			for _, v := range audits[0] {
				if v == blockedText {
					t.Error("audit event carries the configured text")
				}
			}
		})
	}
}

// TestStartSession_ExtensionAllowlist_Allowed pins that a listed extension
// loads normally (no block, no error code).
func TestStartSession_ExtensionAllowlist_Allowed(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	dir := t.TempDir()
	// Directory basename is the identifier when the init name is unused before
	// the allowlist check; the check runs against h.name which resolves to the
	// manifest/init name. We give the extension a manifest so the identifier is
	// deterministic.
	src := `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'init') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { name: 'allowed-ext' } }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }) + '\n');
  }
});
setInterval(() => {}, 1000);
`
	// Manifest fixes the identifier to "allowed-ext" (name resolution:
	// manifest.Name wins over dir basename).
	if err := os.WriteFile(filepath.Join(dir, "extension.json"), []byte(`{"name":"allowed-ext"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	jsPath := filepath.Join(dir, "index.js")
	if err := os.WriteFile(jsPath, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}

	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()

	var mu sync.Mutex
	var codes []string
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_error" {
			mu.Lock()
			codes = append(codes, ev.ErrorCode)
			mu.Unlock()
		}
	})

	cfg := defaultConfig()
	cfg.WorkingDirectory = dir
	cfg.Extensions = []string{jsPath}
	mgr.SetConfig(&types.EngineRuntimeConfig{Enterprise: &types.EnterpriseConfig{
		ExtensionAllowlist: []types.ExtensionAllowlistEntry{{ID: "allowed-ext"}},
	}})

	done := make(chan error, 1)
	go func() {
		_, err := mgr.StartSession("allow1", cfg)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("StartSession failed: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("StartSession timed out")
	}

	mgr.mu.Lock()
	s := mgr.sessions["allow1"]
	hasGroup := s != nil && s.extGroup != nil && !s.extGroup.IsEmpty()
	mgr.mu.Unlock()

	mu.Lock()
	defer mu.Unlock()
	for _, c := range codes {
		if c == "extension_blocked" {
			t.Error("allowed extension must not be blocked")
		}
	}
	if !hasGroup {
		t.Error("allowed extension must load into the session's extension group")
	}
}
