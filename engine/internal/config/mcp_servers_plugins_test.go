package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/plugins"
)

// A plugin's servers join the resolved set under the same rules as a server
// added by hand: the configured one keeps a shared name, and a name no tool
// call could address is refused.
func TestResolveMcpServers_IncludesPluginServers(t *testing.T) {
	seedEngineConfig(t, `{"mcpServers":{"draw":{"type":"http","url":"https://configured.example.com/mcp"}}}`)
	t.Setenv("ION_DATA_DIR", "")

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".mcp.json"), []byte(`{"mcpServers":{
		"draw":{"command":"plugin-draw"},
		"tool":{"command":"${CLAUDE_PLUGIN_ROOT}/bin/tool"},
		"bad__name":{"command":"x"}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := plugins.Register(plugins.InstalledPlugin{Name: "p", Source: "o/p", InstallPath: dir, Version: "abc", InstalledAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	servers := ResolveMcpServers("")
	if got := servers["draw"]; got.URL != "https://configured.example.com/mcp" {
		t.Errorf("configured server replaced by the plugin's: %+v", got)
	}
	if got := servers["tool"]; got.Type != "stdio" || got.Command != dir+"/bin/tool" {
		t.Errorf("plugin server = %+v", got)
	}
	if _, ok := servers["bad__name"]; ok {
		t.Error("plugin server with an unaddressable name was accepted")
	}
}
