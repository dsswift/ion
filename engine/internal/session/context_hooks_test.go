package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// attachTestHost adds an in-process extension host to a started session.
func attachTestHost(t *testing.T, mgr *Manager, key string) *extension.Host {
	t.Helper()
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	s := mgr.sessions[key]
	if s == nil {
		t.Fatalf("session %q not started", key)
	}
	if s.extGroup == nil {
		s.extGroup = extension.NewExtensionGroup()
	}
	host := extension.NewHost()
	s.extGroup.Add(host)
	return host
}

func contextTestSession(t *testing.T, key string) (*Manager, *engineSession, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("KEEP-RULES"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ION.md"), []byte("DROP-RULES"), 0o644); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(newMockBackend())
	cfg := defaultConfig()
	cfg.WorkingDirectory = dir
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatal(err)
	}
	mgr.mu.RLock()
	s := mgr.sessions[key]
	mgr.mu.RUnlock()
	return mgr, s, dir
}

// context_discover is a published hook that nothing fired. A handler that
// returns true must now keep the file out of the system prompt and out of
// context_inject's discovered paths.
func TestInjectContextFiles_ContextDiscoverRejects(t *testing.T) {
	mgr, s, dir := contextTestSession(t, "ctx-discover")
	host := attachTestHost(t, mgr, "ctx-discover")
	var seen []extension.ContextDiscoverInfo
	host.SDK().On(extension.HookContextDiscover, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		info := payload.(extension.ContextDiscoverInfo)
		seen = append(seen, info)
		return strings.HasSuffix(info.Path, "ION.md"), nil
	})

	opts := types.RunOptions{}
	files := mgr.injectContextFiles(s, "ctx-discover", &opts)
	if !strings.Contains(opts.AppendSystemPrompt, "KEEP-RULES") {
		t.Fatalf("accepted file missing from prompt: %q", opts.AppendSystemPrompt)
	}
	if strings.Contains(opts.AppendSystemPrompt, "DROP-RULES") {
		t.Fatal("rejected file reached the prompt")
	}
	for _, f := range files {
		if f.Path == filepath.Join(dir, "ION.md") {
			t.Fatal("rejected file returned for context_inject")
		}
	}
	if len(seen) == 0 {
		t.Fatal("context_discover never fired")
	}
}

func TestInjectContextFiles_ContextLoadRewrites(t *testing.T) {
	mgr, s, _ := contextTestSession(t, "ctx-load")
	host := attachTestHost(t, mgr, "ctx-load")
	host.SDK().On(extension.HookContextLoad, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		info := payload.(extension.ContextLoadInfo)
		if strings.HasSuffix(info.Path, "AGENTS.md") {
			return "REWRITTEN", nil
		}
		return nil, nil
	})

	opts := types.RunOptions{}
	mgr.injectContextFiles(s, "ctx-load", &opts)
	if !strings.Contains(opts.AppendSystemPrompt, "REWRITTEN") || strings.Contains(opts.AppendSystemPrompt, "KEEP-RULES") {
		t.Fatalf("context_load replacement not injected: %q", opts.AppendSystemPrompt)
	}
	if !strings.Contains(opts.AppendSystemPrompt, "DROP-RULES") {
		t.Fatal("a file the handler did not touch must load unchanged")
	}
}
