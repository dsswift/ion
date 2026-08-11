//go:build integration

// bundle_reap_test.go — end-to-end proof that orphaned transpile output is
// reclaimed on the real extension-load path.
//
// The unit tests in internal/extension exercise reapStaleBundles directly.
// This one goes through Host.Load -> transpileTS with a real esbuild run, so
// it also pins that the sweep is actually wired into the path that creates the
// garbage rather than sitting uncalled.

package integration

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
)

const reapExtSrc = `
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.method === 'init') {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{name:'reap-test',tools:[],commands:{}}})+'\n')
  }
})
setInterval(()=>{},1000)
`

// TestBundleReap_LoadReclaimsOrphans simulates the field condition: a
// .ion-build directory full of bundles left behind by daemon lifetimes that
// were killed rather than shut down. The next extension load must reclaim
// them.
func TestBundleReap_LoadReclaimsOrphans(t *testing.T) {
	requireEsbuild(t)

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.ts"), []byte(reapExtSrc), 0o644); err != nil {
		t.Fatalf("write extension: %v", err)
	}

	// Seed orphans the way a killed daemon leaves them: aged, unreferenced,
	// with no host that knows about them.
	buildDir := filepath.Join(dir, ".ion-build")
	if err := os.MkdirAll(buildDir, 0o755); err != nil {
		t.Fatalf("mkdir build dir: %v", err)
	}
	const orphans = 100
	for i := 0; i < orphans; i++ {
		p := filepath.Join(buildDir, fmt.Sprintf("ext-%04d.mjs", i))
		if err := os.WriteFile(p, make([]byte, 2048), 0o644); err != nil {
			t.Fatalf("seed orphan: %v", err)
		}
		mt := time.Now().Add(-time.Duration(i+30) * time.Minute)
		if err := os.Chtimes(p, mt, mt); err != nil {
			t.Fatalf("age orphan: %v", err)
		}
	}

	countBundles := func() int {
		m, _ := filepath.Glob(filepath.Join(buildDir, "ext-*.mjs"))
		return len(m)
	}
	if got := countBundles(); got != orphans {
		t.Fatalf("precondition: %d seeded bundles, want %d", got, orphans)
	}

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	done := make(chan error, 1)
	go func() {
		done <- host.Load(filepath.Join(dir, "index.ts"), &extension.ExtensionConfig{
			ExtensionDir:     dir,
			WorkingDirectory: dir,
		})
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("load: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("load timed out")
	}

	// The sweep keeps a small window plus the bundle this load just wrote.
	after := countBundles()
	if after > 12 {
		t.Errorf("after a load, %d bundles remain — the reaper is not wired into "+
			"the transpile path (seeded %d orphans)", after, orphans)
	}
	if after == 0 {
		t.Error("every bundle was removed, including the one this load is running from")
	}
	t.Logf("reclaimed %d orphaned bundles; %d remain", orphans-after+1, after)

	// The extension must be alive: the sweep must not have deleted the bundle
	// backing the running subprocess.
	if name := host.Name(); name != "reap-test" {
		t.Errorf("extension name = %q, want reap-test — the running subprocess "+
			"lost its entry module", name)
	}
}
