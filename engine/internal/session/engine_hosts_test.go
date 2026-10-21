package session

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// writeScopedExt writes a manifest-driven extension whose init handshake
// declares one interval schedule and the identity_changed hook, and which
// records every fire's _ctx and every identity payload to files in dir. The
// same source runs as the engine host and as the session half of the headless
// session the fire mints, so the test observes both halves of the contract.
func writeScopedExt(t *testing.T, dir, scope string) string {
	t.Helper()
	src := `
const fs = require('fs');
const rl = require('readline').createInterface({ input: process.stdin });
const scope = process.env.ION_EXTENSION_SCOPE || '';
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.id === undefined || msg.id === null) return;
  let result = null;
  if (msg.method === 'init') {
    fs.appendFileSync(__dirname + '/init.log', scope + ' ' + ((msg.params && msg.params.scope) || '') + '\n');
    result = {
      name: 'scoped-ext',
      hooks: ['identity_changed'],
      schedules: [{ id: 'tick', kind: 'interval', intervalMs: 3600000 }],
    };
  } else if (msg.method === 'engine/fire_async') {
    fs.appendFileSync(__dirname + '/fires.log', JSON.stringify(msg.params) + '\n');
  } else if (msg.method === 'hook/identity_changed') {
    fs.appendFileSync(__dirname + '/identity.log', scope + ' ' + JSON.stringify(msg.params) + '\n');
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
});
setInterval(() => {}, 1000);
`
	if err := os.WriteFile(filepath.Join(dir, "index.js"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	manifest := `{"name":"scoped-ext"}`
	if scope != "" {
		manifest = `{"name":"scoped-ext","scope":"` + scope + `"}`
	}
	if err := os.WriteFile(filepath.Join(dir, "extension.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "index.js")
}

func engineHostsManager(t *testing.T, cfg *types.ExtensionHostsConfig) *Manager {
	t.Helper()
	mgr := NewManager(newMockBackend())
	t.Cleanup(mgr.Shutdown)
	mgr.SetHeartbeatInterval(time.Hour)
	mgr.SetConfig(&types.EngineRuntimeConfig{ExtensionHosts: cfg})
	return mgr
}

func waitForFile(t *testing.T, path string, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
			return string(data)
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s never appeared", path)
	return ""
}

func TestStartEngineHosts_NoConfigIsNoop(t *testing.T) {
	mgr := engineHostsManager(t, nil)
	if err := mgr.StartEngineHosts(t.Context()); err != nil {
		t.Fatal(err)
	}
	if mgr.EngineHosts() != nil {
		t.Fatal("no config must load no hosts")
	}
}

func TestStartEngineHosts_RefusesSessionScopedExtension(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}
	dir := t.TempDir()
	path := writeScopedExt(t, dir, "")
	mgr := engineHostsManager(t, &types.ExtensionHostsConfig{Extensions: []string{path}, Session: types.HeadlessSessionConfig{WorkingDirectory: dir}})
	err := mgr.StartEngineHosts(t.Context())
	if err == nil || !strings.Contains(err.Error(), "no engine half") {
		t.Fatalf("error = %v, want the scope refusal", err)
	}
	if group := mgr.EngineHosts(); group != nil && !group.IsEmpty() {
		t.Fatal("a session-scoped extension must not become an engine host")
	}
}

func TestEngineHost_FireMintsHeadlessSessionUnderRunAs(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}
	dir := t.TempDir()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Cleanup(func() {
		if data, err := os.ReadFile(filepath.Join(home, ".ion", "engine.jsonl")); err == nil && t.Failed() {
			for _, line := range strings.Split(string(data), "\n") {
				if strings.Contains(line, "headless") || strings.Contains(line, "fire job") || strings.Contains(line, "stopsession") || strings.Contains(line, "resolve") {
					t.Log(line)
				}
			}
		}
	})
	path := writeScopedExt(t, dir, "both")
	cfg := &types.ExtensionHostsConfig{
		Extensions: []string{path},
		RunAs:      &types.RunAsPrincipalConfig{Mode: types.RunAsModePrincipal, Principal: &types.SessionPrincipal{Subject: "local:tester", Provider: "os", Kind: "local"}},
		Session:    types.HeadlessSessionConfig{WorkingDirectory: dir, IdleReleaseMs: 1000},
	}
	mgr := engineHostsManager(t, cfg)
	releases := recordReleases(mgr)
	if err := mgr.StartEngineHosts(t.Context()); err != nil {
		t.Fatalf("StartEngineHosts: %v", err)
	}
	group := mgr.EngineHosts()
	if group == nil || len(group.Hosts()) != 1 {
		t.Fatal("expected one engine host")
	}
	host := group.Hosts()[0]
	if !host.IsEngineHost() || host.ManifestScope() != extension.ManifestScopeBoth {
		t.Fatalf("host scope = %s/%s", host.Scope(), host.ManifestScope())
	}
	if len(host.Schedules()) != 1 || host.Schedules()[0].JobID != "tick" {
		t.Fatalf("engine host schedules = %+v, want the init-declared tick", host.Schedules())
	}
	if len(host.Tools()) != 0 {
		t.Fatal("an engine host offers no tools")
	}

	// The engine host learns who its sessions act as, with no session key.
	identity := waitForFile(t, filepath.Join(dir, "identity.log"), 10*time.Second)
	if !strings.HasPrefix(identity, "engine ") || !strings.Contains(identity, `"subject":"local:tester"`) || !strings.Contains(identity, `"reason":"run_as"`) {
		t.Fatalf("engine host identity_changed = %q", identity)
	}

	// A fire mints a headless session instead of borrowing one.
	if err := mgr.fireScheduleForEngineHost("scoped-ext", "tick"); err != nil {
		t.Fatalf("fireScheduleForEngineHost: %v", err)
	}
	fire := waitForFile(t, filepath.Join(dir, "fires.log"), 60*time.Second)
	var envelope struct {
		SessionKey string `json:"sessionKey"`
	}
	if err := json.Unmarshal([]byte(strings.SplitN(fire, "\n", 2)[0]), &envelope); err != nil {
		t.Fatalf("decode fire envelope %q: %v", fire, err)
	}
	key := envelope.SessionKey
	if !IsHeadlessKey(key) || !strings.HasPrefix(key, "headless:scoped-ext:") {
		t.Fatalf("fire ran in session %q, want a headless session keyed by the extension", key)
	}
	var info *SessionInfo
	for _, si := range mgr.ListSessions() {
		if si.Key == key {
			copy := si
			info = &copy
		}
	}
	if info == nil {
		t.Fatalf("headless session %q not listed", key)
	}
	if !info.Headless || info.PrincipalSubject != "local:tester" {
		t.Fatalf("headless session info = %+v", info)
	}

	// The session half loaded into the headless session got no schedule:
	// the trigger lives on the engine host.
	mgr.mu.RLock()
	s := mgr.sessions[key]
	mgr.mu.RUnlock()
	if s.extGroup == nil || s.extGroup.IsEmpty() {
		t.Fatal("headless session loaded no session-scoped extensions")
	}
	for _, h := range s.extGroup.Hosts() {
		if h.IsEngineHost() {
			t.Fatal("the headless session must load the session half, not an engine host")
		}
		if n := len(h.Schedules()); n != 0 {
			t.Fatalf("session half registered %d schedule(s); scope mismatch must refuse them", n)
		}
	}
	initLog := waitForFile(t, filepath.Join(dir, "init.log"), time.Second)
	if !strings.Contains(initLog, "engine engine") || !strings.Contains(initLog, "session session") {
		t.Fatalf("init scopes = %q; env and init payload must agree for both halves", initLog)
	}

	// Once quiescent past the headless window, the session is released with
	// no session_before_release round trip.
	mgr.emitHeartbeatTick()
	backdateQuiescence(mgr, key, 2*time.Second)
	mgr.emitHeartbeatTick()
	if hasSession(mgr, key) {
		t.Fatal("quiescent headless session was not released")
	}
	if got := releases.reason(key); got != extension.SessionReleaseReasonIdleTimeout {
		t.Fatalf("release reason = %q", got)
	}
	// The engine host outlives its sessions.
	if host.Dead() {
		t.Fatal("engine host died with its headless session")
	}
}

func TestEngineHost_DispatchHoldsHeadlessSession(t *testing.T) {
	mgr := engineHostsManager(t, &types.ExtensionHostsConfig{Extensions: []string{"/nowhere"}, Session: types.HeadlessSessionConfig{WorkingDirectory: t.TempDir(), IdleReleaseMs: 1000}})
	if _, err := mgr.StartSession("headless:x:1", defaultConfig()); err != nil {
		t.Fatal(err)
	}
	mgr.mu.Lock()
	s := mgr.sessions["headless:x:1"]
	s.headless = true
	mgr.mu.Unlock()
	s.agents.AppendOrUpdateByID(types.AgentStateUpdate{Name: "writer", ID: "d1", Status: "running"}, func(*types.AgentStateUpdate) {})
	mgr.emitHeartbeatTick()
	backdateQuiescence(mgr, "headless:x:1", time.Minute)
	mgr.emitHeartbeatTick()
	if !hasSession(mgr, "headless:x:1") {
		t.Fatal("a running dispatch must hold the headless session open")
	}
	s.agents.AppendOrUpdateByID(types.AgentStateUpdate{ID: "d1"}, func(st *types.AgentStateUpdate) { st.Status = "done" })
	mgr.emitHeartbeatTick()
	backdateQuiescence(mgr, "headless:x:1", time.Minute)
	mgr.emitHeartbeatTick()
	if hasSession(mgr, "headless:x:1") {
		t.Fatal("finished headless session was not released")
	}
}
