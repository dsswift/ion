package session

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
)

func writeForkPlanModeExtension(t *testing.T, dir string) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}
	source := `
const fs = require('fs');
const output = process.env.ION_FORK_PLAN_OUTPUT;
const rl = require('readline').createInterface({ input: process.stdin });
let nextId = 1000;
const pending = new Map();
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  if (msg.method === 'init') {
    send({ jsonrpc: '2.0', id: msg.id, result: { name: 'fork-plan-test', hooks: ['session_start'] } });
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
    const waiter = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message)); else waiter.resolve(msg.result);
    return;
  }
  if (msg.method === 'hook/session_start') {
    try {
      const state = await request('ext/get_plan_mode', {});
      fs.writeFileSync(output, JSON.stringify(state));
      await request('ext/set_plan_mode', { enabled: false, source: 'fork-test' });
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    } catch (err) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(err) } });
    }
    return;
  }
  if (msg.method === 'hook/capability_discover') {
    send({ jsonrpc: '2.0', id: msg.id, result: [] });
    return;
  }
  if (msg.method) send({ jsonrpc: '2.0', id: msg.id, result: null });
});
setInterval(() => {}, 1000);
`
	path := filepath.Join(dir, "fork-plan-extension.js")
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		t.Fatalf("write extension: %v", err)
	}
	return path
}

func TestForkSession_PlanModeVisibleDuringSessionStart(t *testing.T) {
	dir := t.TempDir()
	output := filepath.Join(dir, "seen.json")
	t.Setenv("ION_FORK_PLAN_OUTPUT", output)
	extensionPath := writeForkPlanModeExtension(t, dir)

	mgr := NewManager(newMockBackend())
	defer mgr.Shutdown()
	config := defaultConfig()
	config.WorkingDirectory = dir
	if _, err := mgr.StartSession("fork-plan-source", config); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.SetPlanMode("fork-plan-source", true, []string{"Read"}, "test", "")
	mgr.SetPlanModeBashAllowlist("fork-plan-source", []string{"git status"})

	mgr.mu.Lock()
	sourceSession := mgr.sessions["fork-plan-source"]
	sourceSession.config.Extensions = []string{extensionPath}
	sourceID := sourceSession.conversationID
	mgr.mu.Unlock()
	source := conversation.CreateConversation(sourceID, "system", "test-model")
	conversation.AddUserMessage(source, "first")
	if err := conversation.Save(source, ""); err != nil {
		t.Fatalf("save source: %v", err)
	}

	if _, _, err := mgr.ForkSessionToKey("fork-plan-source", "fork-plan-target", 0); err != nil {
		t.Fatalf("ForkSessionToKey: %v", err)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatalf("read hook observation: %v", err)
	}
	if string(data) != `{"enabled":true,"planFilePath":""}` {
		t.Fatalf("session_start observed %s", data)
	}
	enabled, _ := mgr.GetPlanModeState("fork-plan-target")
	if enabled {
		t.Fatal("session_start plan-mode change was overwritten after startup")
	}
}
