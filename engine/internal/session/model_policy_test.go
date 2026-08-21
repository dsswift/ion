package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestSendPrompt_ModelSelectCannotBypassEnterprisePolicy(t *testing.T) {
	blockedModel := "blocked-by-policy"
	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.SetConfig(&types.EngineRuntimeConfig{Enterprise: &types.EnterpriseConfig{
		BlockedModels: []string{blockedModel},
	}})
	if _, err := mgr.StartSession("model-policy", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	host := extension.NewHost()
	host.SDK().On(extension.HookModelSelect, func(_ *extension.Context, _ interface{}) (interface{}, error) {
		return blockedModel, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)
	mgr.mu.Lock()
	mgr.sessions["model-policy"].extGroup = group
	mgr.mu.Unlock()

	err := mgr.SendPrompt("model-policy", "ordinary prompt", nil)
	if err == nil || !strings.Contains(err.Error(), "not allowed by enterprise policy") {
		t.Fatalf("SendPrompt error = %v, want enterprise-policy rejection", err)
	}
	if len(mb.startedKeys()) != 0 {
		t.Fatal("enterprise-blocked model_select result must not reach backend")
	}
}

func TestSendPrompt_CommandModelRespectsEnterprisePolicy(t *testing.T) {
	workingDir := t.TempDir()
	commandsDir := filepath.Join(workingDir, ".ion", "commands")
	if err := os.MkdirAll(commandsDir, 0o755); err != nil {
		t.Fatalf("MkdirAll commands directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(commandsDir, "fast.md"), []byte("---\nmodel: blocked-command-model\n---\ncheck"), 0o600); err != nil {
		t.Fatalf("WriteFile command: %v", err)
	}

	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.SetConfig(&types.EngineRuntimeConfig{Enterprise: &types.EnterpriseConfig{
		BlockedModels: []string{"blocked-command-model"},
	}})
	if _, err := mgr.StartSession("command-policy", types.EngineConfig{ProfileID: "test", WorkingDirectory: workingDir}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	err := mgr.SendPrompt("command-policy", "/fast", &PromptOverrides{Model: "picker-model", ResolveSlash: true})
	if err == nil || !strings.Contains(err.Error(), "not allowed by enterprise policy") {
		t.Fatalf("SendPrompt error = %v, want command-model policy rejection", err)
	}
	if len(mb.startedKeys()) != 0 {
		t.Fatal("enterprise-blocked command model must not reach backend")
	}
}
