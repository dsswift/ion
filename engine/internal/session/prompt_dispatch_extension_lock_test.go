package session

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// writeReentrantContextInjectExt writes an extension that calls back into the
// engine from inside its context_inject handler: it issues an ext/list_sessions
// request and waits for the response before answering the hook.
//
// That is ordinary extension behaviour — a context_inject handler exists to
// gather context, and gathering it means asking the engine questions (ctx.emit,
// ctx.listSessions, ctx.callTool, ...). The engine must therefore be able to
// answer while the hook is in flight.
func writeReentrantContextInjectExt(t *testing.T, dir string) string {
	t.Helper()
	const src = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
let nextId = 90000;
const waiting = new Map();

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Response to one of our own engine-bound requests.
  if (msg.method === undefined && msg.id !== undefined && waiting.has(msg.id)) {
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    resolve();
    return;
  }
  if (msg.id === undefined || msg.id === null) return;

  if (msg.method === 'init') {
    send({ jsonrpc: '2.0', id: msg.id, result: { name: 'reentrant-ext' } });
    return;
  }

  if (msg.method === 'hook/context_inject') {
    // Ask the engine a question, then answer the hook only once the engine
    // has replied. On an engine that holds the session-manager lock across
    // this hook, the reply can never come and both sides wait forever.
    const id = nextId++;
    waiting.set(id, () => send({ jsonrpc: '2.0', id: msg.id, result: null }));
    send({ jsonrpc: '2.0', id, method: 'ext/list_sessions', params: {} });
    return;
  }

  send({ jsonrpc: '2.0', id: msg.id, result: null });
});
setInterval(() => {}, 1000);
`
	jsPath := filepath.Join(dir, "reentrant-ext.js")
	if err := os.WriteFile(jsPath, []byte(src), 0o644); err != nil {
		t.Fatalf("write tmp ext: %v", err)
	}
	return jsPath
}

// TestSendPrompt_DoesNotHoldManagerLockAcrossExtensionHook is the session-side
// regression test for the engine-wide stall of 2026-08-11.
//
// SendPrompt held the session-manager write lock from the busy check all the way
// through prompt injection, and prompt injection fires the system_inject and
// context_inject hooks. A hook is a synchronous JSON-RPC round trip to the
// extension subprocess with no timeout (extension calls wait indefinitely by
// contract), and the handler on the other end routinely calls back into the
// engine — which needs the lock the caller is holding. The result was a hard
// deadlock that froze every session on the machine: the goroutine dump showed
// 251 goroutines, 11 of them queued on the manager lock behind this one frame,
// and the only recovery was restarting the engine.
//
// RED on unfixed code: restore the injection block to run under m.mu and this
// test's SendPrompt never returns, tripping the deadline below.
func TestSendPrompt_DoesNotHoldManagerLockAcrossExtensionHook(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	dir := t.TempDir()
	const provID = "reentrant-hook-provider"
	const modelID = "reentrant-hook-model"
	mock := &scriptedProvider{
		id:        provID,
		responses: [][]types.LlmStreamEvent{textStreamResponse("done")},
	}
	providers.RegisterProvider(mock)
	providers.RegisterModel(modelID, types.ModelInfo{
		ProviderID:    provID,
		ContextWindow: 200000,
	})

	jsPath := writeReentrantContextInjectExt(t, dir)

	apiBackend := backend.NewApiBackend()
	mgr := NewManager(apiBackend)
	// Shutdown off the test goroutine: in the deadlocked (RED) build it would
	// itself block on the wedged lock and hang the binary instead of failing.
	t.Cleanup(func() { go mgr.Shutdown() })

	cfg := defaultConfig()
	cfg.WorkingDirectory = dir
	cfg.Extensions = []string{jsPath}

	started := make(chan error, 1)
	go func() {
		_, err := mgr.StartSession("reentrant-hook", cfg)
		started <- err
	}()
	select {
	case err := <-started:
		if err != nil {
			t.Fatalf("StartSession failed: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("StartSession timed out")
	}

	sent := make(chan error, 1)
	go func() {
		sent <- mgr.SendPrompt("reentrant-hook", "hello", &PromptOverrides{Model: modelID})
	}()
	select {
	case err := <-sent:
		if err != nil {
			t.Fatalf("SendPrompt failed: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("SendPrompt never returned: the context_inject hook called back into the engine and the manager lock was held across the hook — deadlock")
	}

	// The lock must be genuinely free afterwards, not merely released late.
	done := make(chan struct{})
	go func() {
		mgr.ListSessions()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("ListSessions blocked after SendPrompt returned — manager lock still held")
	}
}
