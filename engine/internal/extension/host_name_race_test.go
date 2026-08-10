package extension

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// host_name_race_test.go — the extension name is read concurrently with the
// handshake that writes it.
//
// An extension that logs at module scope emits a `log` notification before its
// init response lands. The notification handler stamps that line with the
// extension name (rpcLogNotification), and parseInitResult writes the name from
// the handshake — two goroutines, one field, no lock. The race detector flags
// it, and in production it is a torn read of a string header.
//
// This surfaced when the Go SDK's canary logged "canary started" during
// registration, before Run. The TypeScript canary happened not to log at module
// scope, which is why the race went unseen: the bug was always there, and it
// took a second SDK with slightly different startup timing to expose it.

// nameRaceExtensionSrc logs immediately and repeatedly at module scope, then
// answers init with a name different from the directory name. The two writers
// collide only if the name field is unguarded.
const nameRaceExtensionSrc = `
for (let i = 0; i < 40; i++) {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', method: 'log',
    params: { level: 'info', message: 'startup line ' + i, fields: {} }
  }) + '\n');
}
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.method === 'init') {
    for (let i = 0; i < 40; i++) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', method: 'log',
        params: { level: 'info', message: 'init line ' + i, fields: {} }
      }) + '\n');
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { name: 'renamed-by-handshake', tools: [], commands: {} }
    }) + '\n');
    return;
  }
});
setInterval(() => {}, 1000);
`

// TestHostName_NoRaceBetweenLogNotificationAndHandshake pins the fix. Run it
// with -race: on the unguarded field this reports a write in parseInitResult
// against a read in rpcLogNotification.
func TestHostName_NoRaceBetweenLogNotificationAndHandshake(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "index.js"), nameRaceExtensionSrc)

	h := NewHost()
	t.Cleanup(func() { h.Dispose() })

	done := make(chan error, 1)
	go func() {
		done <- h.Load(dir, &ExtensionConfig{ExtensionDir: dir, WorkingDirectory: dir})
	}()

	// Hammer the public reader while the handshake runs, so the read side of
	// the race is guaranteed to be live rather than dependent on log timing.
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					_ = h.Name()
				}
			}
		}()
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
	case <-time.After(30 * time.Second):
		close(stop)
		wg.Wait()
		t.Fatal("Load timed out")
	}

	close(stop)
	wg.Wait()

	if got := h.Name(); got != "renamed-by-handshake" {
		t.Errorf("name = %q, want the handshake name to win over the directory name", got)
	}
}

// TestHostName_ConcurrentReadersSeeAConsistentValue pins that a reader never
// observes a partially-written string. A torn read of a string header yields
// either garbage or a value that is neither the old nor the new name; both
// fail this assertion.
func TestHostName_ConcurrentReadersSeeAConsistentValue(t *testing.T) {
	h := NewHost()
	t.Cleanup(func() { h.Dispose() })

	h.setName("initial")

	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
				h.setName("name-" + strings.Repeat("x", i%64))
			}
		}
	}()

	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					got := h.Name()
					if got != "initial" && !strings.HasPrefix(got, "name-") {
						t.Errorf("observed a torn name value: %q", got)
						return
					}
				}
			}
		}()
	}

	time.Sleep(100 * time.Millisecond)
	close(stop)
	wg.Wait()
}

// TestHostName_FallsBackToDirectoryName pins the fallback path still works
// through the accessor: an extension whose handshake carries no name is
// identified by its directory.
func TestHostName_FallsBackToDirectoryName(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "named-by-directory")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(dir, "index.js"), minimalNoNameExtensionSrc)

	h := NewHost()
	t.Cleanup(func() { h.Dispose() })

	done := make(chan error, 1)
	go func() {
		done <- h.Load(dir, &ExtensionConfig{ExtensionDir: dir, WorkingDirectory: dir})
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Load timed out")
	}

	if got := h.Name(); got != "named-by-directory" {
		t.Errorf("name = %q, want the directory name when the handshake carries none", got)
	}
}

// minimalNoNameExtensionSrc answers init without a name field.
const minimalNoNameExtensionSrc = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.method === 'init') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [], commands: {} } }) + '\n');
  }
});
setInterval(() => {}, 1000);
`
